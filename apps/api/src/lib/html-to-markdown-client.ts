/**
 * HTTP Client for HTML to Markdown conversion service
 * 
 * This client communicates with the Go-based HTML to Markdown microservice
 * to avoid blocking Node.js event loop with heavy conversions.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { logger } from './logger';
import * as Sentry from '@sentry/node';

interface ConvertRequest {
  html: string;
}

interface ConvertResponse {
  markdown: string;
  success: boolean;
}

interface ErrorResponse {
  error: string;
  success: boolean;
}

interface HealthCheckResponse {
  status: string;
  timestamp: string;
  service: string;
}

export class HTMLToMarkdownClient {
  private static instance: HTMLToMarkdownClient;
  private client: AxiosInstance;
  private serviceUrl: string;
  private healthCheckInterval?: NodeJS.Timeout;
  private isHealthy: boolean = false;

  private constructor(serviceUrl: string) {
    this.serviceUrl = serviceUrl;
    this.client = axios.create({
      baseURL: serviceUrl,
      timeout: 30000, // 30 second timeout
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Start health check monitoring
    this.startHealthCheckMonitoring();
  }

  /**
   * Get singleton instance of the client
   * @param serviceUrl URL of the HTML to Markdown service (default: http://localhost:8080)
   */
  public static getInstance(serviceUrl?: string): HTMLToMarkdownClient {
    const url = serviceUrl || process.env.HTML_TO_MARKDOWN_SERVICE_URL || 'http://localhost:8080';
    
    if (!HTMLToMarkdownClient.instance) {
      HTMLToMarkdownClient.instance = new HTMLToMarkdownClient(url);
    }
    
    return HTMLToMarkdownClient.instance;
  }

  /**
   * Start periodic health check monitoring
   */
  private startHealthCheckMonitoring(): void {
    // Initial health check
    this.checkHealth().catch(() => {
      logger.warn('Initial health check failed for HTML to Markdown service');
    });

    // Periodic health checks every 30 seconds
    this.healthCheckInterval = setInterval(() => {
      this.checkHealth().catch(() => {
        // Silent fail, already logged in checkHealth
      });
    }, 30000);
  }

  /**
   * Stop health check monitoring (useful for testing or shutdown)
   */
  public stopHealthCheckMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
  }

  /**
   * Check if the service is healthy
   */
  public async checkHealth(): Promise<boolean> {
    try {
      const response = await this.client.get<HealthCheckResponse>('/health', {
        timeout: 5000, // 5 second timeout for health checks
      });
      
      this.isHealthy = response.data.status === 'healthy';
      
      if (this.isHealthy) {
        logger.debug('HTML to Markdown service is healthy');
      }
      
      return this.isHealthy;
    } catch (error) {
      this.isHealthy = false;
      
      if (axios.isAxiosError(error)) {
        logger.warn('HTML to Markdown service health check failed', {
          message: error.message,
          code: error.code,
          serviceUrl: this.serviceUrl,
        });
      } else {
        logger.warn('HTML to Markdown service health check failed', { error });
      }
      
      return false;
    }
  }

  /**
   * Get current health status without making a request
   */
  public getHealthStatus(): boolean {
    return this.isHealthy;
  }

  /**
   * Convert HTML to Markdown
   * @param html HTML string to convert
   * @returns Markdown string
   * @throws Error if conversion fails
   */
  public async convertHTMLToMarkdown(html: string): Promise<string> {
    if (!html || html.trim() === '') {
      return '';
    }

    const startTime = Date.now();

    try {
      const request: ConvertRequest = { html };
      
      const response = await this.client.post<ConvertResponse>('/convert', request);
      
      const duration = Date.now() - startTime;
      
      if (!response.data.success) {
        throw new Error('Conversion was not successful');
      }

      logger.debug('HTML to Markdown conversion successful', {
        duration_ms: duration,
        input_size: html.length,
        output_size: response.data.markdown.length,
      });

      return response.data.markdown;
    } catch (error) {
      const duration = Date.now() - startTime;

      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError<ErrorResponse>;
        
        const errorMessage = axiosError.response?.data?.error || axiosError.message;
        const statusCode = axiosError.response?.status;

        logger.error('HTML to Markdown conversion failed', {
          error: errorMessage,
          statusCode,
          duration_ms: duration,
          serviceUrl: this.serviceUrl,
          isHealthy: this.isHealthy,
        });

        // Capture in Sentry with additional context
        Sentry.captureException(error, {
          tags: {
            service: 'html-to-markdown',
            status_code: statusCode,
          },
          extra: {
            serviceUrl: this.serviceUrl,
            errorMessage,
            inputSize: html.length,
          },
        });

        throw new Error(`HTML to Markdown conversion failed: ${errorMessage}`);
      } else {
        logger.error('Unexpected error during HTML to Markdown conversion', { error });
        Sentry.captureException(error);
        throw error;
      }
    }
  }

  /**
   * Get service URL
   */
  public getServiceUrl(): string {
    return this.serviceUrl;
  }
}

/**
 * Helper function to get client instance
 */
export function getHTMLToMarkdownClient(serviceUrl?: string): HTMLToMarkdownClient {
  return HTMLToMarkdownClient.getInstance(serviceUrl);
}

