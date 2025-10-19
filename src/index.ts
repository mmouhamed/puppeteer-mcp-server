#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import puppeteer, { Browser, Page } from 'puppeteer';
import { z } from 'zod';

// Schema definitions for tool parameters
const NavigateSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).optional().default('load'),
});

const ScreenshotSchema = z.object({
  fullPage: z.boolean().optional().default(false),
  format: z.enum(['png', 'jpeg', 'webp']).optional().default('png'),
  quality: z.number().min(0).max(100).optional(),
});

const GetTextSchema = z.object({
  selector: z.string().optional(),
});

const ClickSchema = z.object({
  selector: z.string(),
});

const TypeSchema = z.object({
  selector: z.string(),
  text: z.string(),
});

const EvaluateSchema = z.object({
  script: z.string(),
});

class PuppeteerMCPServer {
  private server: Server;
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor() {
    this.server = new Server(
      {
        name: 'puppeteer-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'puppeteer_launch',
          description: 'Launch a new browser instance',
          inputSchema: {
            type: 'object',
            properties: {
              headless: {
                type: 'boolean',
                description: 'Run browser in headless mode',
                default: true,
              },
              viewport: {
                type: 'object',
                properties: {
                  width: { type: 'number', default: 1280 },
                  height: { type: 'number', default: 720 },
                },
              },
            },
          },
        },
        {
          name: 'puppeteer_navigate',
          description: 'Navigate to a URL',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'URL to navigate to' },
              waitUntil: {
                type: 'string',
                enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'],
                default: 'load',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'puppeteer_screenshot',
          description: 'Take a screenshot of the current page',
          inputSchema: {
            type: 'object',
            properties: {
              fullPage: { type: 'boolean', default: false },
              format: { type: 'string', enum: ['png', 'jpeg', 'webp'], default: 'png' },
              quality: { type: 'number', minimum: 0, maximum: 100 },
            },
          },
        },
        {
          name: 'puppeteer_get_text',
          description: 'Get text content from the page or a specific selector',
          inputSchema: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector (optional, gets full page text if not provided)' },
            },
          },
        },
        {
          name: 'puppeteer_click',
          description: 'Click on an element',
          inputSchema: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector of element to click' },
            },
            required: ['selector'],
          },
        },
        {
          name: 'puppeteer_type',
          description: 'Type text into an input field',
          inputSchema: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector of input field' },
              text: { type: 'string', description: 'Text to type' },
            },
            required: ['selector', 'text'],
          },
        },
        {
          name: 'puppeteer_evaluate',
          description: 'Execute JavaScript in the browser context',
          inputSchema: {
            type: 'object',
            properties: {
              script: { type: 'string', description: 'JavaScript code to execute' },
            },
            required: ['script'],
          },
        },
        {
          name: 'puppeteer_close',
          description: 'Close the browser instance',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'puppeteer_launch':
            return await this.launchBrowser(args);
          case 'puppeteer_navigate':
            return await this.navigate(args);
          case 'puppeteer_screenshot':
            return await this.screenshot(args);
          case 'puppeteer_get_text':
            return await this.getText(args);
          case 'puppeteer_click':
            return await this.click(args);
          case 'puppeteer_type':
            return await this.type(args);
          case 'puppeteer_evaluate':
            return await this.evaluate(args);
          case 'puppeteer_close':
            return await this.closeBrowser();
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    });
  }

  private async ensureBrowserAndPage() {
    if (!this.browser) {
      throw new Error('Browser not launched. Use puppeteer_launch first.');
    }
    if (!this.page) {
      this.page = await this.browser.newPage();
    }
  }

  private async launchBrowser(args: any) {
    if (this.browser) {
      await this.browser.close();
    }

    const options: any = {
      headless: args.headless ?? true,
    };

    if (args.viewport) {
      options.defaultViewport = {
        width: args.viewport.width || 1280,
        height: args.viewport.height || 720,
      };
    }

    this.browser = await puppeteer.launch(options);
    this.page = await this.browser.newPage();

    return {
      content: [
        {
          type: 'text',
          text: `Browser launched successfully in ${args.headless ? 'headless' : 'headed'} mode`,
        },
      ],
    };
  }

  private async navigate(args: any) {
    const { url, waitUntil } = NavigateSchema.parse(args);
    await this.ensureBrowserAndPage();

    await this.page!.goto(url, { waitUntil });

    return {
      content: [
        {
          type: 'text',
          text: `Navigated to: ${url}`,
        },
      ],
    };
  }

  private async screenshot(args: any) {
    const { fullPage, format, quality } = ScreenshotSchema.parse(args);
    await this.ensureBrowserAndPage();

    const options: any = { fullPage, type: format };
    if (format === 'jpeg' && quality) {
      options.quality = quality;
    }

    const screenshot = await this.page!.screenshot(options);
    if (!screenshot) {
      throw new Error('Failed to capture screenshot');
    }
    const base64 = Buffer.from(screenshot).toString('base64');

    return {
      content: [
        {
          type: 'text',
          text: `Screenshot taken (${format}, fullPage: ${fullPage})`,
        },
        {
          type: 'image',
          data: base64,
          mimeType: `image/${format}`,
        },
      ],
    };
  }

  private async getText(args: any) {
    const { selector } = GetTextSchema.parse(args);
    await this.ensureBrowserAndPage();

    let text: string;
    if (selector) {
      const element = await this.page!.$(selector);
      if (!element) {
        throw new Error(`Element not found: ${selector}`);
      }
      text = await this.page!.evaluate((el: Element) => el.textContent || '', element);
    } else {
      text = await this.page!.evaluate(() => document.body.textContent || '');
    }

    return {
      content: [
        {
          type: 'text',
          text: selector ? `Text from ${selector}: ${text}` : `Page text: ${text}`,
        },
      ],
    };
  }

  private async click(args: any) {
    const { selector } = ClickSchema.parse(args);
    await this.ensureBrowserAndPage();

    await this.page!.click(selector);

    return {
      content: [
        {
          type: 'text',
          text: `Clicked element: ${selector}`,
        },
      ],
    };
  }

  private async type(args: any) {
    const { selector, text } = TypeSchema.parse(args);
    await this.ensureBrowserAndPage();

    await this.page!.type(selector, text);

    return {
      content: [
        {
          type: 'text',
          text: `Typed "${text}" into ${selector}`,
        },
      ],
    };
  }

  private async evaluate(args: any) {
    const { script } = EvaluateSchema.parse(args);
    await this.ensureBrowserAndPage();

    const result = await this.page!.evaluate((scriptCode: string) => {
      return eval(scriptCode);
    }, script);

    return {
      content: [
        {
          type: 'text',
          text: `Script result: ${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }

  private async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }

    return {
      content: [
        {
          type: 'text',
          text: 'Browser closed successfully',
        },
      ],
    };
  }

  private async cleanup() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Puppeteer MCP server running on stdio');
  }
}

const server = new PuppeteerMCPServer();
server.run().catch(console.error);