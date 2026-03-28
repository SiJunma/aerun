/**
 * Utility for generating random animal-based nicknames.
 */

const adjectives = [
  'Anonymous', 'Brave', 'Clever', 'Dancing', 'Eager', 'Friendly', 
  'Gentle', 'Happy', 'Intelligent', 'Jolly', 'Kind', 'Lucky', 
  'Merry', 'Nice', 'Orange', 'Proud', 'Quick', 'Radiant', 
  'Sunny', 'Thoughtful', 'Unique', 'Vibrant', 'Wise', 'Young', 
  'Zealous', 'Fluffy', 'Silly', 'Speedy', 'Calm', 'Bold'
];

const animals = [
  'Axolotl', 'Badger', 'Beaver', 'Camel', 'Chameleon', 'Cheetah', 
  'Chinchilla', 'Chipmunk', 'Crow', 'Dingo', 'Dinosaur', 'Dolphin', 
  'Duck', 'Elephant', 'Ferret', 'Fox', 'Frog', 'Giraffe', 
  'Gopher', 'Grizzly', 'Hedgehog', 'Hippo', 'Hyena', 'Ibex', 
  'Iguanodon', 'Jackal', 'Kangaroo', 'Koala', 'Kraken', 'Lemur', 
  'Leopard', 'Llama', 'Manatee', 'Mink', 'Monkey', 'Narwhal', 
  'Octopus', 'Otter', 'Panda', 'Penguin', 'Platypus', 'Python', 
  'Rabbit', 'Raccoon', 'Rhino', 'Sheep', 'Shrew', 'Skunk', 
  'Squirrel', 'Tiger', 'Turtle', 'Walrus', 'Wolf', 'Wolverine', 'Wombat'
];

/**
 * Generates a random nickname in the format [Adjective][Animal][Number].
 * Example: "HappyPanda42"
 */
export const generateRandomNickname = () => {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  const num = Math.floor(Math.random() * 99) + 1;
  return `${adj}${animal}${num}`;
};
