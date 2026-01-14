import { Response } from "express";
import { z } from "zod";
import { ErrorResponse, RequestWithAuth } from "./types";
import { supabase_service } from "../../services/supabase";
import { testSlackWebhook } from "../../services/alerts/slack";
import { logger } from "../../lib/logger";

// Zod schemas for request validation
const updateNotificationPreferencesSchema = z.object({
  emailEnabled: z.boolean().optional(),
  emailPreferences: z.array(z.string()).optional(),
  slackEnabled: z.boolean().optional(),
  slackWebhookUrl: z.string().url().nullable().optional(),
  slackPreferences: z.array(z.string()).optional(),
});

type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>;

// Response types
interface NotificationPreferencesData {
  userId: string;
  emailEnabled: boolean;
  emailPreferences: string[];
  slackEnabled: boolean;
  slackWebhookUrl: string | null;
  slackPreferences: string[];
  updatedAt: string;
}

interface GetNotificationPreferencesResponse {
  success: true;
  data: NotificationPreferencesData;
}

interface UpdateNotificationPreferencesResponse {
  success: true;
  data: NotificationPreferencesData;
}

interface TestSlackWebhookResponse {
  success: true;
  message: string;
}

/**
 * GET /v1/user/notification-preferences
 * Fetch the current user's notification preferences
 */
export async function getNotificationPreferencesController(
  req: RequestWithAuth,
  res: Response<GetNotificationPreferencesResponse | ErrorResponse>,
): Promise<void> {
  try {
    const teamId = req.auth.team_id;

    // Get the user associated with this team
    const { data: user, error: userError } = await supabase_service
      .from("users")
      .select("id")
      .eq("team_id", teamId)
      .single();

    if (userError || !user) {
      res.status(404).json({
        success: false,
        error: "User not found for this team",
      });
      return;
    }

    // Get notification preferences
    const { data: preferences, error: prefError } = await supabase_service
      .from("notification_preferences")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (prefError && prefError.code !== "PGRST116") {
      // PGRST116 is "no rows returned"
      logger.error(`Error fetching notification preferences: ${prefError.message}`);
      res.status(500).json({
        success: false,
        error: "Failed to fetch notification preferences",
      });
      return;
    }

    // Return default preferences if none exist
    const responseData: NotificationPreferencesData = {
      userId: user.id,
      emailEnabled: preferences?.unsubscribed_all !== true,
      emailPreferences: preferences?.email_preferences ?? ["rate_limit_warnings", "system_alerts"],
      slackEnabled: preferences?.slack_enabled ?? false,
      slackWebhookUrl: preferences?.slack_webhook_url ?? null,
      slackPreferences: preferences?.slack_preferences ?? [],
      updatedAt: preferences?.updated_at ?? new Date().toISOString(),
    };

    res.json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    logger.error(`Error in getNotificationPreferencesController: ${error}`);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
}

/**
 * PUT /v1/user/notification-preferences
 * Update the current user's notification preferences
 */
export async function updateNotificationPreferencesController(
  req: RequestWithAuth<{}, UpdateNotificationPreferencesInput>,
  res: Response<UpdateNotificationPreferencesResponse | ErrorResponse>,
): Promise<void> {
  try {
    const teamId = req.auth.team_id;

    // Validate request body
    const parseResult = updateNotificationPreferencesSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        success: false,
        error: "Invalid request body",
        details: parseResult.error.errors,
      });
      return;
    }

    const input = parseResult.data;

    // Validate Slack webhook URL format if provided
    if (input.slackWebhookUrl && !input.slackWebhookUrl.startsWith("https://hooks.slack.com/")) {
      res.status(400).json({
        success: false,
        error: "Invalid Slack webhook URL. Must start with https://hooks.slack.com/",
      });
      return;
    }

    // Get the user associated with this team
    const { data: user, error: userError } = await supabase_service
      .from("users")
      .select("id")
      .eq("team_id", teamId)
      .single();

    if (userError || !user) {
      res.status(404).json({
        success: false,
        error: "User not found for this team",
      });
      return;
    }

    // Build update object
    const updateData: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (input.emailEnabled !== undefined) {
      updateData.unsubscribed_all = !input.emailEnabled;
    }
    if (input.emailPreferences !== undefined) {
      updateData.email_preferences = input.emailPreferences;
    }
    if (input.slackEnabled !== undefined) {
      updateData.slack_enabled = input.slackEnabled;
    }
    if (input.slackWebhookUrl !== undefined) {
      updateData.slack_webhook_url = input.slackWebhookUrl;
    }
    if (input.slackPreferences !== undefined) {
      updateData.slack_preferences = input.slackPreferences;
    }

    // Upsert notification preferences
    const { data: updated, error: updateError } = await supabase_service
      .from("notification_preferences")
      .upsert(
        {
          user_id: user.id,
          ...updateData,
        },
        { onConflict: "user_id" }
      )
      .select()
      .single();

    if (updateError) {
      logger.error(`Error updating notification preferences: ${updateError.message}`);
      res.status(500).json({
        success: false,
        error: "Failed to update notification preferences",
      });
      return;
    }

    const responseData: NotificationPreferencesData = {
      userId: user.id,
      emailEnabled: updated?.unsubscribed_all !== true,
      emailPreferences: updated?.email_preferences ?? ["rate_limit_warnings", "system_alerts"],
      slackEnabled: updated?.slack_enabled ?? false,
      slackWebhookUrl: updated?.slack_webhook_url ?? null,
      slackPreferences: updated?.slack_preferences ?? [],
      updatedAt: updated?.updated_at ?? new Date().toISOString(),
    };

    res.json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    logger.error(`Error in updateNotificationPreferencesController: ${error}`);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
}

/**
 * POST /v1/user/notification-preferences/test-slack
 * Test a Slack webhook URL by sending a test message
 */
export async function testSlackWebhookController(
  req: RequestWithAuth<{}, { webhookUrl: string }>,
  res: Response<TestSlackWebhookResponse | ErrorResponse>,
): Promise<void> {
  try {
    const { webhookUrl } = req.body;

    if (!webhookUrl) {
      res.status(400).json({
        success: false,
        error: "webhookUrl is required",
      });
      return;
    }

    // Validate URL format
    if (!webhookUrl.startsWith("https://hooks.slack.com/")) {
      res.status(400).json({
        success: false,
        error: "Invalid Slack webhook URL. Must start with https://hooks.slack.com/",
      });
      return;
    }

    // Test the webhook
    const result = await testSlackWebhook(webhookUrl);

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: `Failed to send test message: ${result.error}`,
      });
      return;
    }

    res.json({
      success: true,
      message: "Test message sent successfully! Check your Slack channel.",
    });
  } catch (error) {
    logger.error(`Error in testSlackWebhookController: ${error}`);
    res.status(500).json({
      success: false,
      error: "Internal server error",
    });
  }
}
