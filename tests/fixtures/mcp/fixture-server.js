/**
 * Fixture MCP server — a real stdio child process for the integration tier.
 *
 * pharos is the realistic server, but it can't be driven into the states we
 * need to test: it declares `tools.listChanged: false`, never returns a
 * malformed tool name, and can't be asked to crash on cue. This one can.
 *
 * Behaviour is selected with FIXTURE_MODE:
 *   normal (default)      — serves the tool set below, honours mutations
 *   crash-after-handshake — completes initialize, then exits
 *   crash-during-list     — exits while serving the first tools/list
 *   no-tools              — handshakes but declares no tools capability
 *   bad-name              — includes a tool whose namespaced name exceeds 64
 *
 * Deliberately hand-written against the SDK's server API rather than shared
 * with src/ — a fixture that imports the code under test can't catch a
 * protocol mistake in it.
 */

const {
  Server
} = require('@modelcontextprotocol/sdk/server/index.js');
const {
  StdioServerTransport
} = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');

const MODE = process.env.FIXTURE_MODE || 'normal';
const INSTRUCTIONS = process.env.FIXTURE_INSTRUCTIONS || 'Fixture server for Moby tests.';

/** Tools whose presence a test can mutate via the `add_tool` call. */
let extraTools = [];

const BASE_TOOLS = [
  {
    name: 'echo',
    description: 'Echo the message back',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message']
    }
  },
  {
    name: 'slow',
    description: 'Sleep for ms milliseconds, then reply',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'number' } },
      required: ['ms']
    }
  },
  {
    name: 'fail',
    description: 'Return an isError result',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'image',
    description: 'Return a non-text content block',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'huge',
    description: 'Return a very large text result',
    inputSchema: {
      type: 'object',
      properties: { chars: { type: 'number' } },
      required: ['chars']
    }
  },
  {
    name: 'add_tool',
    description: 'Register another tool and emit tools/list_changed',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    // Pydantic/FastMCP shape: a $ref pointing at a SIBLING $defs. Pins that
    // the whole inputSchema reaches the wire, not just properties/required.
    name: 'nested',
    description: 'Tool whose schema uses $defs',
    inputSchema: {
      type: 'object',
      properties: { opts: { $ref: '#/$defs/Opts' } },
      required: ['opts'],
      $defs: {
        Opts: {
          type: 'object',
          properties: { depth: { type: 'number' } }
        }
      },
      additionalProperties: false
    }
  }
];

/** Namespaced as mcp__fixture__… this exceeds the 64-char function-name cap. */
const OVERLONG_TOOL = {
  name: 'z'.repeat(60),
  description: 'Name too long once namespaced — must be skipped, not truncated',
  inputSchema: { type: 'object', properties: {} }
};

const capabilities = MODE === 'no-tools' ? {} : { tools: { listChanged: true } };
const server = new Server(
  { name: 'fixture', version: '1.2.3' },
  { capabilities, instructions: INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (MODE === 'crash-during-list') process.exit(3);
  const tools = [...BASE_TOOLS, ...extraTools];
  if (MODE === 'bad-name') tools.push(OVERLONG_TOOL);
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'echo':
      return { content: [{ type: 'text', text: String(args.message ?? '') }] };

    case 'slow':
      await new Promise((r) => setTimeout(r, Number(args.ms) || 0));
      return { content: [{ type: 'text', text: 'finally' }] };

    case 'fail':
      return { content: [{ type: 'text', text: 'the tool refused' }], isError: true };

    case 'image':
      return { content: [{ type: 'image', data: 'QUJD', mimeType: 'image/png' }] };

    case 'huge':
      return { content: [{ type: 'text', text: 'x'.repeat(Number(args.chars) || 0) }] };

    case 'add_tool': {
      extraTools = [
        {
          name: `added_${extraTools.length + 1}`,
          description: 'Added at runtime',
          inputSchema: { type: 'object', properties: {} }
        }
      ];
      // The notification the whole listChanged path hangs on. pharos never
      // sends one, so this is its only coverage.
      await server.sendToolListChanged();
      return { content: [{ type: 'text', text: 'added' }] };
    }

    default:
      return { content: [{ type: 'text', text: `no such tool: ${name}` }], isError: true };
  }
});

server.connect(new StdioServerTransport()).then(() => {
  process.stderr.write(`fixture up mode=${MODE} pid=${process.pid}\n`);
  if (MODE === 'crash-after-handshake') {
    setTimeout(() => process.exit(2), Number(process.env.FIXTURE_CRASH_DELAY_MS || 300));
  }
});
