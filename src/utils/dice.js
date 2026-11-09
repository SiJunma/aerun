/**
 * Scan content for [dice=faces type=...] tags and generate the throw ids.
 *
 * SEC-08: the VALUE of a throw is no longer decided here. The browser used to
 * roll with Math.random and the server only range-checked it, so a forger
 * could submit any value in 1..sides and have it rendered to every reader
 * as the game's truth.
 *
 * This function is now the optimistic-card generator only: it rewrites
 * `[dice=N]` into `[roll=id]` references so the text has the same shape
 * the server will store, and returns ids + sides + type for the optimistic
 * card to paint some placeholder. The REAL value is drawn server-side
 * with crypto/rand (forum.MintDice / RollDraftDice); on reconcile the
 * optimistic card is replaced by the server's content + rolls.
 *
 * Callers that go through the proper write path (forum.js createPost,
 * forum.js updatePost, dms.js) do not need to call this for a thrown value
 * at all — the optimistic card is short-lived and its value is provisional.
 * The function is kept so the optimistic card continues to show the roll
 * block while the server value is in flight.
 *
 * Returns { content: string, rolls: object }
 * The `rolls` map is PROVISIONAL (ids + sides + type, with a random
 * provisional value for the optimistic card to paint). Artificial values
 * are never trusted downstream — the server re-rolls each tag.
 */
export const processDiceRolls = (content) => {
  if (!content) return { content, rolls: {} };
  const rolls = {};
  let rollCounter = 0;

  // Regex to find [dice=sides type=master|secret|...] or [dice=sides]
  const diceRegex = /\[dice=(\d+)(?:\s+type=([a-z]+))?\]/gi;

  const newContent = content.replace(diceRegex, (match, sides, type) => {
    rollCounter++;
    const rollId = `roll_${Date.now()}_${rollCounter}`;
    const numSides = parseInt(sides) || 6;

    // Provisional value for the optimistic card ONLY. It is never sent as
    // truth: the server re-generates the throw with crypto/rand.
    const value = Math.floor(Math.random() * numSides) + 1;

    rolls[rollId] = {
      id: rollId,
      sides: numSides,
      value: value,
      type: type || 'normal',
      timestamp: Date.now()
    };

    // Replace with [roll=id]
    return `[roll=${rollId}]`;
  });

  return { content: newContent, rolls };
};
