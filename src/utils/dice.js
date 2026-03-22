/**
 * Scan content for [dice=faces type=...] tags and generate rolls.
 * Returns { content: string, rolls: object }
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
