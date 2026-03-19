import runServer from './server.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DIRECTIONS = ['up', 'down', 'left', 'right'];

const MOVE_DELTAS = {
  up:    { x: 0,  y: 1  },
  down:  { x: 0,  y: -1 },
  left:  { x: -1, y: 0  },
  right: { x: 1,  y: 0  },
};

// Minimax search depth — increase for harder opponents, lower if you're timing out
const SEARCH_DEPTH = 4;

// Minimum safe area relative to our length (flood fill threshold)
const FLOOD_FILL_SAFETY_RATIO = 0.5;

// ─── Info ─────────────────────────────────────────────────────────────────────

function info() {
  console.log("INFO");
  return {
    apiversion: "2, live",
    author: "",
    color: "#1a1a2e",
    head: "default",
    tail: "default",
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function start(gameState) {
  console.log("GAME START");
}

function end(gameState) {
  console.log("GAME OVER\n");
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Returns the next position given a head and a direction string.
 */
function applyMove(pos, dir) {
  const d = MOVE_DELTAS[dir];
  return { x: pos.x + d.x, y: pos.y + d.y };
}

/**
 * True if `pos` is within board bounds.
 */
function inBounds(pos, board) {
  return pos.x >= 0 && pos.y >= 0 &&
         pos.x < board.width && pos.y < board.height;
}

/**
 * Manhattan distance between two points.
 */
function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Build a Set of all blocked cells from a game state.
 * Optionally exclude the tails of all snakes (they'll move away next turn).
 */
function buildBlockedSet(gameState, excludeTails = false) {
  const blocked = new Set();

  for (const snake of gameState.board.snakes) {
    const bodyToBlock = excludeTails ? snake.body.slice(0, -1) : snake.body;
    for (const seg of bodyToBlock) {
      blocked.add(`${seg.x},${seg.y}`);
    }
  }

  return blocked;
}

/**
 * Get the legal moves for a snake, excluding wall collisions.
 * Does not yet apply body/opponent collision (used in simulation).
 */
function getLegalMoves(head, board) {
  return DIRECTIONS.filter(dir => {
    const next = applyMove(head, dir);
    return inBounds(next, board);
  });
}

// ─── Flood Fill ───────────────────────────────────────────────────────────────

/**
 * BFS flood fill from `startPos`.
 * Returns the number of reachable squares (space available to us).
 * Tails are excluded from blocked since they'll vacate on the next turn.
 */
function floodFill(startPos, gameState) {
  const blocked = buildBlockedSet(gameState, true); // exclude tails
  const { board } = gameState;

  const visited = new Set();
  const queue = [startPos];

  while (queue.length > 0) {
    const pos = queue.shift();
    const key = `${pos.x},${pos.y}`;

    if (visited.has(key)) continue;
    if (blocked.has(key)) continue;
    if (!inBounds(pos, board)) continue;

    visited.add(key);

    for (const dir of DIRECTIONS) {
      queue.push(applyMove(pos, dir));
    }
  }

  return visited.size;
}

// ─── Voronoi Territory ────────────────────────────────────────────────────────

/**
 * Multi-source BFS from all snake heads simultaneously.
 * Returns the fraction of board squares reachable by us before any opponent.
 * A higher score means we control more territory.
 */
function voronoiScore(gameState) {
  const { board } = gameState;
  const myId = gameState.you.id;
  const blocked = buildBlockedSet(gameState, true);

  // owner[key] = snake id that reaches first, or null if contested
  const owner = {};
  const queue = [];

  // Seed with all snake heads
  for (const snake of board.snakes) {
    const head = snake.body[0];
    const key = `${head.x},${head.y}`;
    if (!blocked.has(key)) {
      queue.push({ pos: head, snakeId: snake.id, dist: 0 });
      owner[key] = snake.id;
    }
  }

  // Standard BFS — first to arrive wins the cell
  let qi = 0;
  while (qi < queue.length) {
    const { pos, snakeId, dist } = queue[qi++];

    for (const dir of DIRECTIONS) {
      const next = applyMove(pos, dir);
      const nk = `${next.x},${next.y}`;

      if (!inBounds(next, board)) continue;
      if (blocked.has(nk)) continue;
      if (nk in owner) continue; // already claimed

      owner[nk] = snakeId;
      queue.push({ pos: next, snakeId, dist: dist + 1 });
    }
  }

  const totalCells = board.width * board.height;
  const myCells = Object.values(owner).filter(id => id === myId).length;

  return myCells / totalCells;
}

// ─── BFS Food Pathfinding ─────────────────────────────────────────────────────

/**
 * BFS from `startPos` to find the shortest real path to ANY food.
 * Returns { dist, firstMove } where firstMove is the direction to take
 * from startPos to reach the nearest food optimally.
 * Returns null if no food is reachable.
 */
function bfsToFood(startPos, gameState) {
  const { board } = gameState;
  const blocked = buildBlockedSet(gameState, true); // tails vacate
  const foodSet = new Set(board.food.map(f => `${f.x},${f.y}`));

  if (foodSet.size === 0) return null;

  // Queue entries: { pos, firstMove, dist }
  const visited = new Set([`${startPos.x},${startPos.y}`]);
  const queue = [];

  // Seed queue with all first moves from startPos
  for (const dir of DIRECTIONS) {
    const next = applyMove(startPos, dir);
    const key = `${next.x},${next.y}`;
    if (!inBounds(next, board)) continue;
    if (blocked.has(key)) continue;
    queue.push({ pos: next, firstMove: dir, dist: 1 });
    visited.add(key);
  }

  let qi = 0;
  while (qi < queue.length) {
    const { pos, firstMove, dist } = queue[qi++];
    const key = `${pos.x},${pos.y}`;

    // Found food!
    if (foodSet.has(key)) {
      return { dist, firstMove };
    }

    for (const dir of DIRECTIONS) {
      const next = applyMove(pos, dir);
      const nk = `${next.x},${next.y}`;
      if (!inBounds(next, board)) continue;
      if (blocked.has(nk)) continue;
      if (visited.has(nk)) continue;
      visited.add(nk);
      queue.push({ pos: next, firstMove, dist: dist + 1 });
    }
  }

  return null; // no food reachable
}

/**
 * Returns a food score for the evaluator.
 * - Always active (not just when starving)
 * - Based on real BFS distance, not Manhattan
 * - Scaled by health urgency so it intensifies as health drops
 */
function foodScore(gameState) {
  const me = gameState.you;
  const myHead = me.body[0];
  const { board } = gameState;

  if (board.food.length === 0) return 0;

  const result = bfsToFood(myHead, gameState);
  if (!result) return 0;

  const maxDist = board.width + board.height;

  // Base score: always reward being close to food (not just when starving)
  const distScore = Math.max(0, 1 - result.dist / maxDist);

  // Urgency multiplier: ramps from 1.0 (full health) to 3.0 (near death)
  const healthUrgency = 1 + 2 * (1 - me.health / 100);

  return distScore * healthUrgency;
}

// ─── State Evaluation ─────────────────────────────────────────────────────────

/**
 * Heuristic evaluation of a game state from our perspective.
 * Higher = better for us.
 */
function evaluate(gameState) {
  const me = gameState.you;
  const myHead = me.body[0];
  const { board } = gameState;
  const opponents = board.snakes.filter(s => s.id !== me.id);

  // Immediate death
  if (me.health <= 0) return -10000;
  if (!board.snakes.find(s => s.id === me.id)) return -10000;

  // Space: flood fill from our head
  const space = floodFill(myHead, gameState);
  const spaceRatio = space / (board.width * board.height);

  // Territory: Voronoi control
  const territory = voronoiScore(gameState);

  // Length advantage over all opponents
  const longestOpponent = opponents.length > 0
    ? Math.max(...opponents.map(s => s.length))
    : 0;
  const lengthAdvantage = me.length - longestOpponent; // positive = we're bigger

  // Health/food urgency
  const food = foodScore(gameState);

  // Survival: heavily penalise tiny space
  const survivalPenalty = space < me.length ? -500 : 0;

  // Critical health penalty — ramp up food priority sharply below 30hp
  const healthPenalty = me.health < 30 ? (me.health - 30) * 10 : 0;

  return (
    spaceRatio      * 200  +
    territory       * 250  +
    lengthAdvantage * 40   +
    food            * 400  +  // food is now the dominant signal
    (me.health / 100) * 80 +
    survivalPenalty        +
    healthPenalty
  );
}

// ─── Game State Simulation ────────────────────────────────────────────────────

/**
 * Deep clone only the parts of gameState we mutate.
 * Avoids cloning everything for performance.
 */
function cloneState(gameState) {
  return {
    ...gameState,
    you: {
      ...gameState.you,
      body: gameState.you.body.map(s => ({ ...s })),
      health: gameState.you.health,
    },
    board: {
      ...gameState.board,
      food: gameState.board.food.map(f => ({ ...f })),
      snakes: gameState.board.snakes.map(snake => ({
        ...snake,
        body: snake.body.map(s => ({ ...s })),
        health: snake.health,
      })),
    },
  };
}

/**
 * Move a single snake in the cloned state and handle:
 * - health decrement
 * - food eating (grows + restores health)
 * - wall/body death
 */
function applySnakeMove(state, snakeId, dir) {
  const snake = state.board.snakes.find(s => s.id === snakeId);
  if (!snake) return state;

  const newHead = applyMove(snake.body[0], dir);

  // Check wall collision → kill snake
  if (!inBounds(newHead, state.board)) {
    state.board.snakes = state.board.snakes.filter(s => s.id !== snakeId);
    if (snakeId === state.you.id) state.you.health = 0;
    return state;
  }

  // Move body: add new head, remove tail unless eating
  const newBody = [newHead, ...snake.body];
  snake.health -= 1;

  // Food check
  const foodIndex = state.board.food.findIndex(
    f => f.x === newHead.x && f.y === newHead.y
  );

  if (foodIndex !== -1) {
    snake.health = 100;
    state.board.food.splice(foodIndex, 1);
    // Don't remove tail — snake grows
  } else {
    newBody.pop(); // remove tail
    if (snake.health <= 0) {
      // Starved
      state.board.snakes = state.board.snakes.filter(s => s.id !== snakeId);
      if (snakeId === state.you.id) state.you.health = 0;
      return state;
    }
  }

  snake.body = newBody;

  // Sync you reference
  if (snakeId === state.you.id) {
    state.you = snake;
  }

  return state;
}

/**
 * Simulate all snakes moving simultaneously.
 * After movement, resolve body collisions and head-to-head collisions.
 */
function simulateState(gameState, myDir, opponentDirs) {
  let state = cloneState(gameState);
  const myId = state.you.id;

  // Apply our move first
  state = applySnakeMove(state, myId, myDir);

  // Apply opponent moves
  const opponentIds = gameState.board.snakes
    .filter(s => s.id !== myId)
    .map(s => s.id);

  opponentIds.forEach((id, i) => {
    const dir = opponentDirs[i] || 'up';
    state = applySnakeMove(state, id, dir);
  });

  // Resolve body-on-body collisions (snakes that moved into occupied cells)
  const bodyCells = {};
  for (const snake of state.board.snakes) {
    for (let i = 1; i < snake.body.length; i++) {
      const key = `${snake.body[i].x},${snake.body[i].y}`;
      bodyCells[key] = true;
    }
  }

  const heads = state.board.snakes.map(s => ({
    id: s.id,
    head: s.body[0],
    length: s.length,
  }));

  // Head-to-head: smaller snake dies (or both die if same length)
  for (let i = 0; i < heads.length; i++) {
    for (let j = i + 1; j < heads.length; j++) {
      const a = heads[i];
      const b = heads[j];
      if (a.head.x === b.head.x && a.head.y === b.head.y) {
        if (a.length <= b.length) {
          state.board.snakes = state.board.snakes.filter(s => s.id !== a.id);
          if (a.id === state.you.id) state.you.health = 0;
        }
        if (b.length <= a.length) {
          state.board.snakes = state.board.snakes.filter(s => s.id !== b.id);
          if (b.id === state.you.id) state.you.health = 0;
        }
      }
    }
  }

  // Kill snakes whose head is in another snake's body
  state.board.snakes = state.board.snakes.filter(snake => {
    const key = `${snake.body[0].x},${snake.body[0].y}`;
    if (bodyCells[key]) {
      if (snake.id === state.you.id) state.you.health = 0;
      return false;
    }
    return true;
  });

  return state;
}

// ─── Minimax with Alpha-Beta Pruning ──────────────────────────────────────────

/**
 * Get the "best guess" move for an opponent snake using a simple greedy strategy.
 * Used in minimax when simulating opponent behaviour.
 */
function getOpponentMove(gameState, snake) {
  const head = snake.body[0];
  const blocked = buildBlockedSet(gameState, false);
  const myHead = gameState.you.body[0];

  // Try to move away from our head (opponents play defensively in our model)
  const moves = DIRECTIONS.filter(dir => {
    const next = applyMove(head, dir);
    const key = `${next.x},${next.y}`;
    return inBounds(next, gameState.board) && !blocked.has(key);
  });

  if (moves.length === 0) return 'up';

  // Paranoid: opponent tries to minimise our space (pick move toward our head)
  moves.sort((a, b) => {
    const na = applyMove(head, a);
    const nb = applyMove(head, b);
    return manhattan(nb, myHead) - manhattan(na, myHead);
  });

  return moves[0];
}

/**
 * Paranoid minimax — we maximise, all opponents collectively minimise.
 * Alpha-beta pruning for performance.
 */
function minimax(gameState, depth, isMaximizing, alpha, beta) {
  const me = gameState.you;
  const myId = me.id;
  const aliveSelf = gameState.board.snakes.find(s => s.id === myId);

  // Terminal: dead or depth exhausted
  if (!aliveSelf || me.health <= 0) return -10000;
  if (depth === 0) return evaluate(gameState);

  const opponents = gameState.board.snakes.filter(s => s.id !== myId);
  const opponentMoves = opponents.map(opp => getOpponentMove(gameState, opp));

  if (isMaximizing) {
    // Our turn: try all our moves
    let best = -Infinity;

    const myHead = me.body[0];
    const myMoves = getLegalMoves(myHead, gameState.board);

    if (myMoves.length === 0) return -10000;

    for (const dir of myMoves) {
      const newState = simulateState(gameState, dir, opponentMoves);
      const score = minimax(newState, depth - 1, false, alpha, beta);
      best = Math.max(best, score);
      alpha = Math.max(alpha, score);
      if (beta <= alpha) break; // prune
    }

    return best;
  } else {
    // Opponents' turn: they collectively minimise our score
    // We simulate all their possible moves and take the worst for us
    let worst = Infinity;

    if (opponents.length === 0) {
      return minimax(gameState, depth - 1, true, alpha, beta);
    }

    // For each opponent, try all their legal moves; pick worst for us
    for (const opponent of opponents) {
      const head = opponent.body[0];
      const theirMoves = getLegalMoves(head, gameState.board);

      for (const oppDir of theirMoves) {
        const theirMovesAll = opponents.map(o =>
          o.id === opponent.id ? oppDir : getOpponentMove(gameState, o)
        );
        const newState = simulateState(gameState, getLegalMoves(me.body[0], gameState.board)[0], theirMovesAll);
        const score = minimax(newState, depth - 1, true, alpha, beta);
        worst = Math.min(worst, score);
        beta = Math.min(beta, score);
        if (beta <= alpha) break;
      }
    }

    return worst === Infinity ? evaluate(gameState) : worst;
  }
}

// ─── Move ─────────────────────────────────────────────────────────────────────

function move(gameState) {
  const me = gameState.you;
  const myHead = me.body[0];
  const { board } = gameState;
  const blocked = buildBlockedSet(gameState, false);
  const opponents = board.snakes.filter(s => s.id !== me.id);

  // ── Step 1: Basic safety filters ──────────────────────────────────────────

  const isMoveSafe = {};

  for (const dir of DIRECTIONS) {
    const next = applyMove(myHead, dir);
    const key = `${next.x},${next.y}`;

    if (!inBounds(next, board)) { isMoveSafe[dir] = false; continue; }
    if (blocked.has(key))        { isMoveSafe[dir] = false; continue; }

    isMoveSafe[dir] = true;
  }

  // ── Step 2: Flood fill — avoid pockets ────────────────────────────────────

  const floodFiltered = {};

  for (const dir of DIRECTIONS) {
    if (!isMoveSafe[dir]) { floodFiltered[dir] = false; continue; }

    const next = applyMove(myHead, dir);
    const space = floodFill(next, gameState);
    const minSpace = me.length * FLOOD_FILL_SAFETY_RATIO;

    floodFiltered[dir] = space >= minSpace;
  }

  // Use flood fill if any pass, otherwise fall back to basic safety
  const floodSafe = DIRECTIONS.filter(d => floodFiltered[d]);
  const basicSafe = DIRECTIONS.filter(d => isMoveSafe[d]);
  const safeMoves = floodSafe.length > 0 ? floodSafe : basicSafe;

  if (safeMoves.length === 0) {
    console.log(`MOVE ${gameState.turn}: No safe moves. Moving down.`);
    return { move: 'down' };
  }

  if (safeMoves.length === 1) {
    console.log(`MOVE ${gameState.turn}: Only one safe move → ${safeMoves[0]}`);
    return { move: safeMoves[0] };
  }

  // ── Step 3: Head-to-head danger avoidance ────────────────────────────────

  // Mark moves that lead to a cell reachable by a larger/equal snake's head
  const h2hDanger = new Set();

  for (const opponent of opponents) {
    const oppHead = opponent.body[0];
    for (const dir of DIRECTIONS) {
      const oppNext = applyMove(oppHead, dir);
      const key = `${oppNext.x},${oppNext.y}`;
      if (opponent.length >= me.length) {
        h2hDanger.add(key);
      }
    }
  }

  const h2hSafe = safeMoves.filter(dir => {
    const next = applyMove(myHead, dir);
    return !h2hDanger.has(`${next.x},${next.y}`);
  });

  const candidateMoves = h2hSafe.length > 0 ? h2hSafe : safeMoves;

  // ── Step 3.5: BFS food override ───────────────────────────────────────────
  // If we have a direct BFS path to food AND that first move is in our
  // candidate set, force it as the only candidate when health is low OR
  // we're shorter than the longest opponent (need to grow).
  // This ensures the snake ALWAYS hunts food, not just when evaluator nudges it.

  const foodPath = bfsToFood(myHead, gameState);
  const longestOpponentLen = opponents.length > 0
    ? Math.max(...opponents.map(s => s.length))
    : 0;

  const shouldChaseFood =
    me.health < 60 ||                    // getting hungry
    me.length <= longestOpponentLen ||    // need to grow to compete
    me.health < 100;                      // always eat if not full

  if (foodPath && shouldChaseFood && candidateMoves.includes(foodPath.firstMove)) {
    // Only override if the food move is genuinely safe (flood fill passes)
    const foodNext = applyMove(myHead, foodPath.firstMove);
    const foodSpace = floodFill(foodNext, gameState);
    if (foodSpace >= me.length * FLOOD_FILL_SAFETY_RATIO) {
      console.log(`MOVE ${gameState.turn}: Food BFS override → ${foodPath.firstMove} (dist: ${foodPath.dist}, health: ${me.health})`);
      return { move: foodPath.firstMove };
    }
  }

  // ── Step 4: Minimax search ────────────────────────────────────────────────

  let bestMove = candidateMoves[0];
  let bestScore = -Infinity;

  for (const dir of candidateMoves) {
    const opponentMoves = opponents.map(opp => getOpponentMove(gameState, opp));
    const newState = simulateState(gameState, dir, opponentMoves);
    const score = minimax(newState, SEARCH_DEPTH - 1, false, -Infinity, Infinity);

    console.log(`  [minimax] ${dir}: ${score.toFixed(1)}`);

    if (score > bestScore) {
      bestScore = score;
      bestMove = dir;
    }
  }

  console.log(`MOVE ${gameState.turn}: ${bestMove} (score: ${bestScore.toFixed(1)})`);
  return { move: bestMove };
}

// ─── Server ───────────────────────────────────────────────────────────────────

runServer({ info, start, move, end });