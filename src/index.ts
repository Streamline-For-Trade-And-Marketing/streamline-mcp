#!/usr/bin/env node
/**
 * Streamline MCP server entry point.
 *
 * Transport: stdio. Suitable for Claude Desktop and Claude Code, which
 * spawn the binary and pipe JSON-RPC over stdin/stdout. A future HTTP/SSE
 * transport will replace this for multi-tenant cloud deployment, but
 * stdio is the right shape for the POC because:
 *   1. No port bindings or TLS to worry about.
 *   2. Authentication = env var. The user sets STREAMLINE_TOKEN in their
 *      MCP config and we never see anyone else's data.
 *   3. Easy to log/debug — stderr is reserved for our diagnostics, only
 *      stdout is the MCP channel.
 *
 * Env vars:
 *   STREAMLINE_TOKEN   (required) — Bearer token for /vendor/v1.
 *                                   Get it from the mobile app's
 *                                   AsyncStorage key `@streamline:token`
 *                                   or from a fresh login POST.
 *   STREAMLINE_BASE    (optional) — Override the base URL. Defaults to
 *                                   production. Set to the staging URL
 *                                   for testing.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from './zod-to-jsonschema.js';
import { VendorClient } from './vendor-client.js';
import { buildTools } from './tools.js';

const token = process.env.STREAMLINE_TOKEN;
const baseURL = process.env.STREAMLINE_BASE;

if (!token) {
  // Print to stderr so it doesn't pollute the JSON-RPC channel.
  console.error(
    '[streamline-mcp] FATAL: STREAMLINE_TOKEN is not set.\n' +
      'Add it to your MCP server config — see README.md for instructions.',
  );
  process.exit(1);
}

const api = new VendorClient({ token, baseURL });
const tools = buildTools(api);
const toolsByName = new Map(tools.map((t) => [t.name, t]));

const server = new Server(
  {
    name: 'streamline-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Advertise tools to the client (Claude). Each tool's input schema is
// converted from Zod to JSON Schema so the model can build correct
// arguments.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
  })),
}));

// Dispatch incoming tool calls. We return both the structured result
// (so Claude can reason about JSON) AND a text block (so the user can
// see something readable if Claude renders it directly).
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = toolsByName.get(name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    };
  }
  // Validate arguments — the model occasionally hands us extra fields
  // or wrong types. Zod surfaces a clean error message we forward.
  const parsed = tool.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Invalid arguments for ${name}: ${parsed.error.message}`,
        },
      ],
    };
  }
  try {
    const result = await tool.handler(parsed.data);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err: any) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error calling ${name}: ${err?.message ?? String(err)}`,
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Heartbeat to stderr so we know the server actually started — the
// stdio transport silently buffers if anything goes wrong on connect.
console.error(
  `[streamline-mcp] ready. ${tools.length} tools registered. base=${baseURL ?? 'production'}`,
);
