import axios from "axios";
import { logger } from "../../../src/lib/logger";

import { config } from "../../config";
import { NotificationType } from "../../types";

export async function sendSlackWebhook(
  message: string,
  alertEveryone: boolean = false,
  webhookUrl: string = config.SLACK_WEBHOOK_URL ?? "",
) {
  const messagePrefix = alertEveryone ? "<!channel> " : "";
  const payload = {
    text: `${messagePrefix} ${message}`,
  };

  try {
    const response = await axios.post(webhookUrl, payload, {
      headers: {
        "Content-Type": "application/json",
      },
    });
    logger.info("Webhook sent successfully:", response.data);
  } catch (error) {
    logger.debug(`Error sending webhook: ${error}`);
  }
}

// Notification type to human-readable message mapping
const notificationMessages: Record<NotificationType, { title: string; description: string; emoji: string }> = {
  [NotificationType.APPROACHING_LIMIT]: {
    title: "Approaching Credit Limit",
    description: "You've used 80% of your credit limit for this billing period.",
    emoji: ":warning:",
  },
  [NotificationType.LIMIT_REACHED]: {
    title: "Credit Limit Reached",
    description: "You've reached your credit limit. Upgrade your plan to continue.",
    emoji: ":octagonal_sign:",
  },
  [NotificationType.RATE_LIMIT_REACHED]: {
    title: "Rate Limit Reached",
    description: "You've hit an API rate limit. Please wait before retrying.",
    emoji: ":hourglass:",
  },
  [NotificationType.AUTO_RECHARGE_SUCCESS]: {
    title: "Auto-Recharge Successful",
    description: "Your account has been automatically recharged with additional credits.",
    emoji: ":white_check_mark:",
  },
  [NotificationType.AUTO_RECHARGE_FAILED]: {
    title: "Auto-Recharge Failed",
    description: "Your automatic recharge failed. Please check your payment method.",
    emoji: ":x:",
  },
  [NotificationType.CONCURRENCY_LIMIT_REACHED]: {
    title: "Concurrency Limit Reached",
    description: "You're hitting your concurrency limit. Consider upgrading for faster scraping.",
    emoji: ":zap:",
  },
  [NotificationType.AUTO_RECHARGE_FREQUENT]: {
    title: "Frequent Auto-Recharges Detected",
    description: "Consider upgrading your plan for better pricing and more included credits.",
    emoji: ":bulb:",
  },
};

/**
 * Send a notification to a user's Slack webhook URL
 * Uses Slack Block Kit for rich formatting
 */
export async function sendUserSlackNotification(
  webhookUrl: string,
  notificationType: NotificationType,
  teamId: string,
  context?: { autoRechargeCredits?: number },
): Promise<{ success: boolean; error?: string }> {
  const message = notificationMessages[notificationType];
  if (!message) {
    return { success: false, error: `Unknown notification type: ${notificationType}` };
  }

  let description = message.description;
  if (notificationType === NotificationType.AUTO_RECHARGE_SUCCESS && context?.autoRechargeCredits) {
    description = `Your account has been recharged with ${context.autoRechargeCredits.toLocaleString()} credits.`;
  }

  const payload = {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${message.emoji} Firecrawl: ${message.title}`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: description,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<https://firecrawl.dev/app|View Dashboard> | <https://firecrawl.dev/app/settings|Manage Notifications>`,
          },
        ],
      },
    ],
  };

  try {
    const response = await axios.post(webhookUrl, payload, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });
    logger.info(`User Slack notification sent successfully for team ${teamId}:`, response.data);
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn(`Error sending user Slack notification for team ${teamId}: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

/**
 * Test a Slack webhook URL by sending a test message
 */
export async function testSlackWebhook(
  webhookUrl: string,
): Promise<{ success: boolean; error?: string }> {
  const payload = {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: ":white_check_mark: Firecrawl Slack Integration Test",
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Your Slack webhook is configured correctly! You will now receive Firecrawl notifications here.",
        },
      },
    ],
  };

  try {
    await axios.post(webhookUrl, payload, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });
    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}
