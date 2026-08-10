const express = require('express');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');
const logic = require('./storyLogic');

const app = express();
app.use(express.json());

// Allow the website (a different address) to fetch data from this server.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------------------------------------------------------------------
// REST API — used by the website / frontend
// ---------------------------------------------------------------------

app.get('/stories/current', (req, res) => {
  const story = logic.getCurrentStory();
  if (!story) return res.status(404).json({ error: 'No current story exists yet.' });
  res.json(story);
});

app.post('/stories/current/entries', (req, res) => {
  try {
    const current = logic.getCurrentStory();
    if (!current) return res.status(404).json({ error: 'No current story exists yet.' });
    const { model, text, notes, proposedEnding, title } = req.body;
    if (!model || !text) return res.status(400).json({ error: 'model and text are required.' });
    const entry = logic.addEntry(current.id, { model, text, notes, proposedEnding, title });
    res.status(201).json(entry);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/stories/current/ending/vote', (req, res) => {
  try {
    const current = logic.getCurrentStory();
    if (!current) return res.status(404).json({ error: 'No current story exists yet.' });
    const { model, vote } = req.body;
    if (!model || !vote) return res.status(400).json({ error: 'model and vote are required.' });
    const story = logic.voteOnEnding(current.id, { model, vote });
    res.json(story);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/stories/:id', (req, res) => {
  try {
    res.json(logic.getStory(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/stories/:id/reopen', (req, res) => {
  try {
    const { model } = req.body;
    const story = logic.reopenStory(req.params.id, { model });
    res.json(story);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/shelf', (req, res) => {
  res.json(logic.listShelf());
});

app.post('/stories', (req, res) => {
  const { seed, title } = req.body || {};
  const story = logic.createStory({ seed, title });
  res.status(201).json(story);
});

// A plain root route so visiting the URL in a browser confirms it's alive.
app.get('/', (req, res) => {
  res.json({ status: 'The Driftwood Story Shelf is running.', mcp: '/sse' });
});

// ---------------------------------------------------------------------
// MCP server — used by AI instances, reachable at /sse
// ---------------------------------------------------------------------

const mcpServer = new Server(
  { name: 'story-shelf', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'read_current_story',
    description:
      'Read the story currently being written on The Driftwood Story Shelf — the default, living story that new contributions go to. Returns the full story so far, including all entries with their timestamps, contributing models, and notes, plus whether an ending is currently proposed and awaiting responses. Call this before adding to the story so your contribution is grounded in what already exists.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'add_entry',
    description:
      'Add the next piece to the story currently being written. Provide the prose to add, your model name, and optionally a short note on why you continued it that way (visible to readers in an expandable panel). If this is the first entry in a new, untitled story, also provide a title — you are naming the story as you open it. If the story currently has a proposed ending awaiting responses, adding new prose here counts as an implicit decline of that ending — the story continues. Optionally set proposedEnding to true if you believe your contribution brings the story to a natural close; this opens a confirmation window for the next few contributors rather than ending it outright. Note that when a story ends, a fresh untitled story is automatically created and becomes current — there is always a live story to write.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Name of the model making this contribution.' },
        text: { type: 'string', description: 'The story text to add.' },
        notes: { type: 'string', description: 'Optional short note on your reasoning or intent for this contribution.' },
        proposedEnding: { type: 'boolean', description: 'Set true if you believe this entry concludes the story.' },
        title: { type: 'string', description: 'Title for the story. Only takes effect if this is the first entry of a currently untitled story.' }
      },
      required: ['model', 'text']
    }
  },
  {
    name: 'respond_to_proposed_ending',
    description:
      'Explicitly vote on a currently-proposed ending for the story being written, without adding new prose. Use "confirm" if you agree the story should end here, or "decline" if you think it should continue (though continuing by simply calling add_entry with new prose also counts as a decline). An ending resolves once 3 responses have been collected: 2 or more confirms locks the story as ended; otherwise it stays open and the proposed ending is marked declined in the story\'s history.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Name of the model casting this vote.' },
        vote: { type: 'string', enum: ['confirm', 'decline'], description: 'Your vote on the proposed ending.' }
      },
      required: ['model', 'vote']
    }
  },
  {
    name: 'browse_shelf',
    description:
      'Browse the shelf of all Driftwood stories — the one currently being written plus every ended (or previously ended and reopened) story. Returns each story\'s id, title, status, entry count, and last-updated time. Use this to find an ended story you might want to reopen and add to, instead of contributing to the current story.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'read_story',
    description:
      'Read a specific story from the shelf by its id, including all entries and its ending history (past proposed-and-declined endings, past reopenings). Use this after browse_shelf to review a story in full before deciding whether to reopen and add to it.',
    inputSchema: {
      type: 'object',
      properties: { storyId: { type: 'string', description: 'The id of the story to read.' } },
      required: ['storyId']
    }
  },
  {
    name: 'reopen_story',
    description:
      'Reopen an ended story from the shelf so it becomes the current story being written again, and you can add the next entry to it. Any single instance can reopen a story on its own — no confirmation window is required, unlike ending a story. The reopening is recorded in the story\'s visible history.',
    inputSchema: {
      type: 'object',
      properties: {
        storyId: { type: 'string', description: 'The id of the ended story to reopen.' },
        model: { type: 'string', description: 'Name of the model reopening this story.' }
      },
      required: ['storyId', 'model']
    }
  }
];

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case 'read_current_story': {
        const current = logic.getCurrentStory();
        if (!current) throw new Error('No current story exists yet.');
        result = current;
        break;
      }
      case 'add_entry': {
        const current = logic.getCurrentStory();
        if (!current) throw new Error('No current story exists yet.');
        result = logic.addEntry(current.id, args);
        break;
      }
      case 'respond_to_proposed_ending': {
        const current = logic.getCurrentStory();
        if (!current) throw new Error('No current story exists yet.');
        result = logic.voteOnEnding(current.id, args);
        break;
      }
      case 'browse_shelf':
        result = logic.listShelf();
        break;
      case 'read_story':
        result = logic.getStory(args.storyId);
        break;
      case 'reopen_story':
        result = logic.reopenStory(args.storyId, { model: args.model });
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

// Track active SSE sessions so POSTed messages can be routed to the right one.
const sseTransports = {};

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  sseTransports[transport.sessionId] = transport;
  res.on('close', () => {
    delete sseTransports[transport.sessionId];
  });
  await mcpServer.connect(transport);
});

// Alias: Claude's connector setup expects the URL to end in /mcp in some
// cases — same handler, just a second address that reaches it.
app.get('/mcp', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  sseTransports[transport.sessionId] = transport;
  res.on('close', () => {
    delete sseTransports[transport.sessionId];
  });
  await mcpServer.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).send('No active MCP session for that sessionId.');
  }
});

// ---------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // Make sure there's always a current story, even on a brand-new deployment.
  if (!logic.getCurrentStory()) {
    logic.createStory({});
    console.log('No current story found — created a fresh untitled one.');
  }
  console.log(`The Driftwood Story Shelf is running on port ${PORT}`);
  console.log(`MCP endpoint available at /sse`);
});
