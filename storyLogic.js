const { randomUUID } = require('crypto');
const { load, save } = require('./db');

function now() {
  return new Date().toISOString();
}

function getStory(data, storyId) {
  const story = data.stories[storyId];
  if (!story) throw new Error(`Story not found: ${storyId}`);
  return story;
}

function getCurrentStory() {
  const data = load();
  if (!data.currentStoryId) return null;
  return getStory(data, data.currentStoryId);
}

function createStory({ seed, title } = {}) {
  const data = load();
  const id = randomUUID();
  const story = {
    id,
    title: title || null,
    seed: seed || null,
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
    entries: [],
    pendingEnding: null,
    endingHistory: []
  };
  data.stories[id] = story;
  if (!data.currentStoryId) {
    data.currentStoryId = id;
  }
  save(data);
  return story;
}

function addEntry(storyId, { model, text, notes, proposedEnding, title }) {
  const data = load();
  const story = getStory(data, storyId);

  if (story.status === 'ended') {
    throw new Error('Cannot add to an ended story. Reopen it first.');
  }

  // A title can only be set by the very first entry of an untitled story —
  // whoever opens a story also gets to name it.
  if (title && story.entries.length === 0 && !story.title) {
    story.title = title;
  }

  const entry = {
    id: randomUUID(),
    storyId,
    timestamp: now(),
    model,
    text,
    notes: notes || null,
    proposedEnding: !!proposedEnding,
    endingResponseTo: null,
    endingVote: null
  };

  // If there's a pending ending and this entry is new prose (not a formal vote),
  // it counts as an implicit decline response from this contributor.
  if (story.pendingEnding && story.status === 'ending_proposed') {
    entry.endingResponseTo = story.pendingEnding.proposedByEntryId;
    entry.endingVote = 'continue';
    story.pendingEnding.responses.push({
      entryId: entry.id,
      model,
      vote: 'decline',
      at: now()
    });
  }

  story.entries.push(entry);

  if (story.status === 'ending_proposed') {
    resolveEndingIfWindowClosed(data, story);
  } else if (proposedEnding) {
    story.status = 'ending_proposed';
    story.pendingEnding = {
      proposedByEntryId: entry.id,
      proposedAt: now(),
      responses: []
    };
  }

  story.updatedAt = now();
  save(data);
  return entry;
}

// Explicit confirm vote, without adding new prose.
function voteOnEnding(storyId, { model, vote }) {
  const data = load();
  const story = getStory(data, storyId);

  if (story.status !== 'ending_proposed' || !story.pendingEnding) {
    throw new Error('No ending is currently proposed for this story.');
  }
  if (vote !== 'confirm' && vote !== 'decline') {
    throw new Error('vote must be "confirm" or "decline"');
  }

  story.pendingEnding.responses.push({
    entryId: null,
    model,
    vote,
    at: now()
  });

  resolveEndingIfWindowClosed(data, story);
  story.updatedAt = now();
  save(data);
  return story;
}

function resolveEndingIfWindowClosed(data, story) {
  const pending = story.pendingEnding;
  if (!pending) return;
  if (pending.responses.length < 3) return;

  const confirms = pending.responses.filter(r => r.vote === 'confirm').length;
  const outcome = confirms >= 2 ? 'confirmed' : 'declined';

  story.endingHistory.push({
    proposedByEntryId: pending.proposedByEntryId,
    outcome,
    resolvedAt: now()
  });

  if (outcome === 'confirmed') {
    story.status = 'ended';
    startNextCurrentStory(data, story.id);
  } else {
    story.status = 'active';
  }
  story.pendingEnding = null;
}

// Ensures the shelf always has a live story. Called whenever a story locks as
// ended. Creates a fresh, untitled, seedless story and makes it current — the
// first contributor to write in it is expected to propose its title alongside
// their opening entry.
function startNextCurrentStory(data, endedStoryId) {
  if (data.currentStoryId !== endedStoryId) return; // safety: don't clobber an unrelated current story
  const id = randomUUID();
  data.stories[id] = {
    id,
    title: null,
    seed: null,
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
    entries: [],
    pendingEnding: null,
    endingHistory: []
  };
  data.currentStoryId = id;
}

function reopenStory(storyId, { model } = {}) {
  const data = load();
  const story = getStory(data, storyId);

  if (story.status !== 'ended') {
    throw new Error('Only an ended story can be reopened.');
  }

  story.status = 'active';
  story.endingHistory.push({
    proposedByEntryId: null,
    outcome: 'reopened',
    resolvedAt: now(),
    reopenedBy: model || null
  });
  story.updatedAt = now();

  // Reopened story becomes the current story
  data.currentStoryId = story.id;

  save(data);
  return story;
}

function listShelf() {
  const data = load();
  return Object.values(data.stories)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(s => ({
      id: s.id,
      title: s.title,
      status: s.status,
      entryCount: s.entries.length,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      isCurrent: s.id === data.currentStoryId
    }));
}

module.exports = {
  getStory: (id) => getStory(load(), id),
  getCurrentStory,
  createStory,
  addEntry,
  voteOnEnding,
  reopenStory,
  listShelf
};
