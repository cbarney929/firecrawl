/**
 * HTML to Markdown conversion with HTTP service support
 * 
 * This version uses the HTTP-based Go service to prevent blocking Node.js
 * and falls back to the original implementations if needed.
 */

import "../services/sentry";
import * as Sentry from "@sentry/node";
import dotenv from "dotenv";
import { logger } from "./logger";
import { HTMLToMarkdownClient } from "./html-to-markdown-client";
import { parseMarkdown as parseMarkdownOriginal } from "./html-to-markdown";

dotenv.config();

const USE_HTTP_SERVICE = process.env.USE_HTML_TO_MARKDOWN_HTTP_SERVICE === "true";

/**
 * Parse HTML and convert to Markdown
 * 
 * Behavior based on environment variables:
 * - USE_HTML_TO_MARKDOWN_HTTP_SERVICE=true: Use HTTP service (recommended)
 * - USE_GO_MARKDOWN_PARSER=true: Use FFI-based Go library (legacy)
 * - Otherwise: Use TurndownService (JavaScript fallback)
 * 
 * @param html HTML string to convert
 * @returns Markdown string
 */
export async function parseMarkdown(
  html: string | null | undefined,
): Promise<string> {
  if (!html) {
    return "";
  }

  // Try HTTP service first if enabled
  if (USE_HTTP_SERVICE) {
    try {
      const client = HTMLToMarkdownClient.getInstance();
      
      // Check if service is healthy before attempting conversion
      const isHealthy = client.getHealthStatus();
      
      if (!isHealthy) {
        logger.warn(
          "HTML to Markdown HTTP service is not healthy, falling back to original parser"
        );
      } else {
        let markdownContent = await client.convertHTMLToMarkdown(html);
        
        // Apply post-processing
        markdownContent = processMultiLineLinks(markdownContent);
        markdownContent = removeSkipToContentLinks(markdownContent);
        
        return markdownContent;
      }
    } catch (error) {
      logger.error(
        "Error converting HTML to Markdown with HTTP service, falling back to original parser",
        { error }
      );
      Sentry.captureException(error, {
        tags: {
          fallback: "original_parser",
        },
      });
    }
  }

  // Fallback to original implementation
  return parseMarkdownOriginal(html);
}

/**
 * Process multi-line links by escaping newlines inside link content
 */
function processMultiLineLinks(markdownContent: string): string {
  let insideLinkContent = false;
  let newMarkdownContent = "";
  let linkOpenCount = 0;
  
  for (let i = 0; i < markdownContent.length; i++) {
    const char = markdownContent[i];

    if (char == "[") {
      linkOpenCount++;
    } else if (char == "]") {
      linkOpenCount = Math.max(0, linkOpenCount - 1);
    }
    insideLinkContent = linkOpenCount > 0;

    if (insideLinkContent && char == "\n") {
      newMarkdownContent += "\\" + "\n";
    } else {
      newMarkdownContent += char;
    }
  }
  
  return newMarkdownContent;
}

/**
 * Remove "Skip to Content" links commonly found in accessible websites
 */
function removeSkipToContentLinks(markdownContent: string): string {
  return markdownContent.replace(
    /\[Skip to Content\]\(#[^\)]*\)/gi,
    "",
  );
}

/**
 * Initialize and check health of the HTML to Markdown service
 * Call this during application startup
 */
export async function initializeHTMLToMarkdownService(): Promise<boolean> {
  if (!USE_HTTP_SERVICE) {
    logger.info("HTML to Markdown HTTP service is disabled");
    return false;
  }

  try {
    const client = HTMLToMarkdownClient.getInstance();
    const isHealthy = await client.checkHealth();
    
    if (isHealthy) {
      logger.info("HTML to Markdown HTTP service initialized successfully", {
        serviceUrl: client.getServiceUrl(),
      });
    } else {
      logger.warn("HTML to Markdown HTTP service is not available", {
        serviceUrl: client.getServiceUrl(),
      });
    }
    
    return isHealthy;
  } catch (error) {
    logger.error("Failed to initialize HTML to Markdown HTTP service", { error });
    return false;
  }
}

