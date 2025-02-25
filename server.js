const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');

// Create Express server for serving static files
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server and WebSocket server
const server = http.createServer(app);
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ server });

console.log(`Snake Battle Server running on port ${PORT}`);

const GRID_SIZE = 20;
const GRID_COUNT = 25;
const GAME_SPEED = 150;
const MAX_BULLETS = 3;
const REFILL_INTERVAL = 60000; // 60 seconds
const MAX_PLAYERS = 4;
const FOOD_POINTS_FOR_KILLED_SNAKE = 5; // Number of food segments created when a snake is eliminated
const POWERUP_SPAWN_CHANCE = 0.005; // 0.5% chance per tick to spawn a power-up (reduced from 2%)
const MAX_POWERUPS = 3; // Maximum power-ups on the board at once

// Game state
let players = {}; // Active players (up to MAX_PLAYERS)
let spectators = {}; // Spectators (unlimited)
let foods = [];
let remainingFood = []; // Food from eliminated players
let powerups = []; // Active power-ups on the board
let eliminatedPlayers = {}; // Track eliminated players
let gameRunning = false;
let hostId = null; // Store the host's playerId
let gameInterval = null;
let activeBombs = []; // Track planted bombs

// Food types with different values and appearances
const foodTypes = [
    { color: '#2ecc71', value: 1, size: 0.8 }, // Regular food
    { color: '#f1c40f', value: 2, size: 0.9 }, // Special food
    { color: '#9b59b6', value: 3, size: 1.0 }  // Rare food
];

// Power-up types
const powerupTypes = [
    {
        id: 'freeze',
        name: 'Freeze',
        color: '#3498db',
        symbol: '❄️',
        duration: 3000, // 3 seconds
        rarity: 0.25 // 25% of power-ups will be this type
    },
    {
        id: 'speed',
        name: 'Speed Boost',
        color: '#f1c40f',
        symbol: '⚡',
        duration: 5000, // 5 seconds
        rarity: 0.20 // 20% of power-ups will be this type
    },
    {
        id: 'shield',
        name: 'Shield',
        color: '#7f8c8d',
        symbol: '🛡️',
        duration: 5000, // 5 seconds
        rarity: 0.15 // 15% of power-ups will be this type
    },
    {
        id: 'magnet',
        name: 'Magnet',
        color: '#e74c3c',
        symbol: '🧲',
        duration: 10000, // 10 seconds (increased from 4 seconds)
        rarity: 0.20 // 20% of power-ups will be this type
    },
    {
        id: 'bomb',
        name: 'Bomb',
        color: '#2c3e50',
        symbol: '💣',
        fuseDuration: 3000, // 3 seconds before explosion
        blastRadius: 3, // Tiles from center that the bomb affects
        rarity: 0.20 // 20% of power-ups will be this type
    }
];

// Generate random food at valid position
function generateFood() {
    let position, valid;
    do {
        position = {
            x: Math.floor(Math.random() * GRID_COUNT),
            y: Math.floor(Math.random() * GRID_COUNT)
        };
        valid = !Object.values(players).some(p =>
            p.body.some(s => s.x === position.x && s.y === position.y)
        ) && !foods.some(f => f.x === position.x && f.y === position.y)
          && !remainingFood.some(f => f.x === position.x && f.y === position.y)
          && !powerups.some(p => p.x === position.x && p.y === position.y)
          && !activeBombs.some(b => b.x === position.x && b.y === position.y);
    } while (!valid);

    const rand = Math.random();
    let foodType = rand < 0.7 ? foodTypes[0] : rand < 0.9 ? foodTypes[1] : foodTypes[2];
    foods.push({ x: position.x, y: position.y, type: foodType, pulse: 0, pulseDelta: 0.05 });
}

// Try to spawn a power-up
function trySpawnPowerup() {
    if (powerups.length >= MAX_POWERUPS) return;
    if (Math.random() > POWERUP_SPAWN_CHANCE) return;
    let position, valid;
    let attempts = 0;
    do {
        attempts++;
        position = {
            x: Math.floor(Math.random() * GRID_COUNT),
            y: Math.floor(Math.random() * GRID_COUNT)
        };
        valid = !Object.values(players).some(p =>
            p.body.some(s => s.x === position.x && s.y === position.y)
        ) && !foods.some(f => f.x === position.x && f.y === position.y)
          && !remainingFood.some(f => f.x === position.x && f.y === position.y)
          && !powerups.some(p => p.x === position.x && p.y === position.y)
          && !activeBombs.some(b => b.x === position.x && b.y === position.y);
        if (attempts > 50) return;
    } while (!valid);

    const typeSelector = Math.random();
    let cumulativeRarity = 0;
    let selectedType;
    for (const type of powerupTypes) {
        cumulativeRarity += type.rarity;
        if (typeSelector <= cumulativeRarity) {
            selectedType = type;
            break;
        }
    }
    if (!selectedType) selectedType = powerupTypes[0];
    powerups.push({
        x: position.x,
        y: position.y,
        type: selectedType,
        pulse: 0,
        pulseDelta: 0.05,
        spawnTime: Date.now()
    });
    broadcast({
        type: 'powerupSpawned',
        powerups
    });
}

// Generate food from eliminated player
function generatePlayerFood(player) {
    if (!player || !player.body || player.body.length === 0) return;
    const segmentsToConvert = Math.min(player.body.length, FOOD_POINTS_FOR_KILLED_SNAKE);
    const step = Math.floor(player.body.length / segmentsToConvert);
    for (let i = 0; i < segmentsToConvert; i++) {
        const segmentIndex = i * step;
        if (segmentIndex < player.body.length) {
            const segment = player.body[segmentIndex];
            remainingFood.push({
                x: segment.x,
                y: segment.y,
                value: 1,
                color: player.color,
                playerId: player.playerId
            });
        }
    }
}

// Apply freeze power-up effect
function applyFreezePowerup(activatorId) {
    const activator = players[activatorId];
    if (!activator) return;
    Object.entries(players).forEach(([id, player]) => {
        if (id !== activatorId && !eliminatedPlayers[id]) {
            player.activeEffects = player.activeEffects || {};
            player.activeEffects.frozen = {
                startTime: Date.now(),
                duration: powerupTypes.find(p => p.id === 'freeze').duration,
                activatorId
            };
        }
    });
    broadcast({
        type: 'powerupActivated',
        powerupId: 'freeze',
        activatorId,
        message: `${activator.name} froze all opponents!`
    });
    setTimeout(() => {
        Object.values(players).forEach(player => {
            if (player.activeEffects && player.activeEffects.frozen) {
                delete player.activeEffects.frozen;
            }
        });
        broadcast({
            type: 'powerupExpired',
            powerupId: 'freeze',
            message: 'Players unfrozen!'
        });
    }, powerupTypes.find(p => p.id === 'freeze').duration);
}

// Apply speed boost power-up effect
function applySpeedPowerup(playerId) {
    const player = players[playerId];
    if (!player) return;
    player.activeEffects = player.activeEffects || {};
    player.activeEffects.speedBoost = {
        startTime: Date.now(),
        duration: powerupTypes.find(p => p.id === 'speed').duration
    };
    broadcast({
        type: 'powerupActivated',
        powerupId: 'speed',
        activatorId: playerId,
        message: `${player.name} got a speed boost!`
    });
    setTimeout(() => {
        if (players[playerId] && players[playerId].activeEffects) {
            delete players[playerId].activeEffects.speedBoost;
            broadcast({
                type: 'powerupExpired',
                powerupId: 'speed',
                playerId,
                message: `${player.name}'s speed boost ended!`
            });
        }
    }, powerupTypes.find(p => p.id === 'speed').duration);
}

// Apply shield power-up effect
function applyShieldPowerup(playerId) {
    const player = players[playerId];
    if (!player) return;
    player.activeEffects = player.activeEffects || {};
    player.activeEffects.shield = {
        startTime: Date.now(),
        duration: powerupTypes.find(p => p.id === 'shield').duration
    };
    broadcast({
        type: 'powerupActivated',
        powerupId: 'shield',
        activatorId: playerId,
        message: `${player.name} activated a shield!`
    });
    setTimeout(() => {
        if (players[playerId] && players[playerId].activeEffects) {
            delete players[playerId].activeEffects.shield;
            broadcast({
                type: 'powerupExpired',
                powerupId: 'shield',
                playerId,
                message: `${player.name}'s shield expired!`
            });
        }
    }, powerupTypes.find(p => p.id === 'shield').duration);
}

// Apply magnet power-up effect
function applyMagnetPowerup(playerId) {
    const player = players[playerId];
    if (!player) return;
    player.activeEffects = player.activeEffects || {};
    player.activeEffects.magnet = {
        startTime: Date.now(),
        duration: powerupTypes.find(p => p.id === 'magnet').duration,
        radius: 5
    };
    broadcast({
        type: 'powerupActivated',
        powerupId: 'magnet',
        activatorId: playerId,
        message: `${player.name} activated a food magnet!`
    });
    setTimeout(() => {
        if (players[playerId] && players[playerId].activeEffects) {
            delete players[playerId].activeEffects.magnet;
            broadcast({
                type: 'powerupExpired',
                powerupId: 'magnet',
                playerId,
                message: `${player.name}'s magnet deactivated!`
            });
        }
    }, powerupTypes.find(p => p.id === 'magnet').duration);
}

// Plant a bomb at the player's head position
function plantBomb(playerId) {
    const player = players[playerId];
    if (!player || player.body.length === 0) return;
    const head = player.body[0];
    const bomb = {
        x: head.x,
        y: head.y,
        ownerId: playerId,
        plantTime: Date.now(),
        fuseDuration: powerupTypes.find(p => p.id === 'bomb').fuseDuration,
        blastRadius: powerupTypes.find(p => p.id === 'bomb').blastRadius,
        countdown: 3
    };
    activeBombs.push(bomb);
    broadcast({
        type: 'bombPlanted',
        bomb,
        message: `${player.name} planted a bomb!`
    });
    const countdownInterval = setInterval(() => {
        bomb.countdown--;
        if (bomb.countdown <= 0) {
            clearInterval(countdownInterval);
        }
        broadcast({
            type: 'bombCountdown',
            bombId: activeBombs.indexOf(bomb),
            countdown: bomb.countdown
        });
    }, 1000);
    setTimeout(() => {
        const bombIndex = activeBombs.indexOf(bomb);
        if (bombIndex !== -1) {
            activeBombs.splice(bombIndex, 1);
        }
        let playersHit = [];
        Object.entries(players).forEach(([id, targetPlayer]) => {
            if (eliminatedPlayers[id]) return;
            for (let i = 0; i < targetPlayer.body.length; i++) {
                const segment = targetPlayer.body[i];
                const distance = Math.sqrt(
                    Math.pow(segment.x - bomb.x, 2) + 
                    Math.pow(segment.y - bomb.y, 2)
                );
                if (distance <= bomb.blastRadius) {
                    if (i === 0) {
                        playersHit.push({
                            id,
                            player: targetPlayer,
                            isHead: true,
                            segmentIndex: i
                        });
                    } else {
                        playersHit.push({
                            id,
                            player: targetPlayer,
                            isHead: false,
                            segmentIndex: i
                        });
                    }
                    break;
                }
            }
        });
        let gameEnded = false;
        let justEliminated = [];
        playersHit.filter(hit => hit.isHead).forEach(hit => {
            const bombOwner = players[bomb.ownerId];
            const ownerName = bombOwner ? bombOwner.name : 'Someone';
            if (bomb.ownerId !== hit.id) {
                if (bombOwner) {
                    bombOwner.score += 10;
                }
            }
            if (eliminatePlayer(hit.id, `was blown up by ${ownerName}'s bomb`)) {
                gameEnded = true;
                return;
            }
            justEliminated.push(hit.id);
        });
        if (gameEnded) return;
        playersHit.filter(hit => !hit.isHead).forEach(hit => {
            if (justEliminated.includes(hit.id)) return;
            hit.player.body.splice(hit.segmentIndex);
            if (players[bomb.ownerId] && bomb.ownerId !== hit.id) {
                players[bomb.ownerId].score += 3;
            }
            if (hit.player.body.length <= 1) {
                const bombOwner = players[bomb.ownerId];
                const ownerName = bombOwner ? bombOwner.name : 'Someone';
                if (eliminatePlayer(hit.id, `was reduced to nothing by ${ownerName}'s bomb`)) {
                    gameEnded = true;
                    return;
                }
                justEliminated.push(hit.id);
            }
        });
        broadcast({
            type: 'bombExploded',
            x: bomb.x,
            y: bomb.y,
            radius: bomb.blastRadius,
            playersHit: playersHit.map(hit => ({
                id: hit.id,
                isHead: hit.isHead
            })),
            justEliminated,
            message: `Bomb exploded!`
        });
    }, bomb.fuseDuration);
}

// Bullet refill timer
const bulletRefillInterval = setInterval(() => {
    if (gameRunning) {
        Object.values(players).forEach(player => {
            if (!eliminatedPlayers[player.playerId]) {
                player.bullets = MAX_BULLETS;
            }
        });
        broadcast({ type: 'updateBullets', players });
    }
}, REFILL_INTERVAL);

// Place initial food
for (let i = 0; i < 3; i++) generateFood();

// Choose a new host when the current host disconnects
function assignNewHost() {
    const playerIds = Object.keys(players);
    if (playerIds.length > 0) {
        hostId = playerIds[0];
        const player = players[hostId];
        if (player) {
            console.log(`New host assigned: ${player.name} (${hostId})`);
        }
    } else {
        hostId = null;
        console.log('No players left to be host');
        resetGame();
    }
}

// Reset the game state
function resetGame() {
    gameRunning = false;
    eliminatedPlayers = {};
    if (gameInterval) {
        clearInterval(gameInterval);
        gameInterval = null;
    }
    foods = [];
    remainingFood = [];
    powerups = [];
    activeBombs = [];
    for (let i = 0; i < 3; i++) generateFood();
    Object.keys(players).forEach(id => {
        adjustPlayerSpawn(id, Object.keys(players).indexOf(id) + 1);
        players[id].score = 0;
        players[id].bullets = MAX_BULLETS;
        players[id].activeBullets = [];
        players[id].activeEffects = {};
    });
}

// Get current game state for new connections
function getCurrentState() {
    return {
        players,
        spectators,
        foods,
        remainingFood,
        powerups,
        activeBombs,
        eliminatedPlayers,
        gameRunning,
        hostId
    };
}

// Broadcast to all connected clients
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Position players in different corners based on player count
function adjustPlayerSpawn(playerId, playerIndex) {
    const player = players[playerId];
    if (!player) return;
    switch (playerIndex % 4) {
        case 1: // Upper left, moving right
            player.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }];
            player.direction = 'right';
            player.nextDirection = 'right';
            break;
        case 2: // Upper right, moving down
            player.body = [{ x: 20, y: 5 }, { x: 20, y: 4 }, { x: 20, y: 3 }];
            player.direction = 'down';
            player.nextDirection = 'down';
            break;
        case 3: // Lower right, moving left
            player.body = [{ x: 20, y: 20 }, { x: 21, y: 20 }, { x: 22, y: 20 }];
            player.direction = 'left';
            player.nextDirection = 'left';
            break;
        case 0: // Lower left, moving up
            player.body = [{ x: 5, y: 20 }, { x: 5, y: 21 }, { x: 5, y: 22 }];
            player.direction = 'up';
            player.nextDirection = 'up';
            break;
    }
}

// Eliminate a player
function eliminatePlayer(playerId, reason) {
    const player = players[playerId];
    if (!player || eliminatedPlayers[playerId]) return false;
    console.log(`Player ${player.name} (${playerId}) eliminated: ${reason}`);
    eliminatedPlayers[playerId] = {
        reason,
        timestamp: Date.now(),
        score: player.score
    };
    generatePlayerFood(player);
    broadcast({
        type: 'playerEliminated',
        eliminatedId: playerId,
        eliminatedName: player.name,
        eliminatedPlayers,
        remainingFood
    });
    const activePlayers = Object.keys(players).filter(id => !eliminatedPlayers[id]);
    if (activePlayers.length === 1) {
        const winnerId = activePlayers[0];
        const winner = players[winnerId];
        gameOver(`${winner.name} wins by elimination!`);
        return true;
    } else if (activePlayers.length === 0) {
        gameOver('No players left! Game over.');
        return true;
    }
    return false;
}

// Calculate a lighter shade of a color for bullets
function lightenColor(hexColor, percent) {
    if (!hexColor || typeof hexColor !== 'string') return '#ffffff';
    hexColor = hexColor.replace('#', '');
    let r = parseInt(hexColor.substring(0, 2), 16);
    let g = parseInt(hexColor.substring(2, 4), 16);
    let b = parseInt(hexColor.substring(4, 6), 16);
    r = Math.min(255, Math.floor(r + (255 - r) * (percent / 100)));
    g = Math.min(255, Math.floor(g + (255 - g) * (percent / 100)));
    b = Math.min(255, Math.floor(b + (255 - b) * (percent / 100)));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// Start a new game
function startGame() {
    if (Object.keys(players).length === 0) {
        console.log("Cannot start game with no players");
        return;
    }
    resetGame();
    gameRunning = true;
    Object.keys(players).forEach((id, index) => {
        adjustPlayerSpawn(id, index + 1);
    });
    gameInterval = setInterval(updateGame, GAME_SPEED);
    broadcast({ 
        type: 'startGame', 
        players, 
        foods, 
        spectators,
        eliminatedPlayers,
        powerups,
        activeBombs,
        remainingFood,
        gameRunning,
        hostId
    });
    console.log("Game started with", Object.keys(players).length, "players");
}

// Pause the game
function pauseGame() {
    if (gameRunning) {
        gameRunning = false;
        if (gameInterval) {
            clearInterval(gameInterval);
            gameInterval = null;
        }
        broadcast({ 
            type: 'gamePaused', 
            message: 'Game paused. Waiting for players to reconnect...',
            players,
            spectators,
            eliminatedPlayers,
            powerups,
            activeBombs,
            remainingFood,
            hostId
        });
        console.log("Game paused");
    }
}

// End the current game with a winner
function gameOver(message) {
    gameRunning = false;
    if (gameInterval) {
        clearInterval(gameInterval);
        gameInterval = null;
    }
    const finalScores = {};
    Object.entries(players).forEach(([id, p]) => {
        finalScores[id] = {
            name: p.name,
            score: p.score,
            color: p.color
        };
    });
    broadcast({ 
        type: 'gameOver', 
        message, 
        finalScores,
        eliminatedPlayers,
        hostId 
    });
    console.log("Game over:", message);
    setTimeout(() => {
        resetGame();
        broadcast({ 
            type: 'updateLobby', 
            players, 
            spectators, 
            hostId,
            eliminatedPlayers,
            gameRunning: false
        });
    }, 5000);
}

// Handle new WebSocket connections
wss.on('connection', (ws, req) => {
    const playerId = Date.now().toString();
    const clientIp = req.socket.remoteAddress;
    console.log(`Client ${playerId} connected from ${clientIp}`);
    let role = 'Spectator';
    if (!hostId) {
        role = 'Server Host';
        hostId = playerId;
    } else if (Object.keys(players).length < MAX_PLAYERS && !gameRunning) {
        role = 'Player';
    }
    ws.playerId = playerId;
    if (role === 'Player' || role === 'Server Host') {
        const baseColor = `#${Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0')}`;
        const lighterColor = lightenColor(baseColor, 20);
        const darkerColor = baseColor;
        players[playerId] = {
            name: `Player ${playerId.slice(-4)}`,
            body: [],
            color: baseColor,
            tailColor: lighterColor,
            headColor: darkerColor,
            direction: 'right',
            nextDirection: 'right',
            score: 0,
            bullets: MAX_BULLETS,
            activeBullets: [],
            activeEffects: {},
            playerId
        };
        adjustPlayerSpawn(playerId, Object.keys(players).length);
    } else if (role === 'Spectator') {
        spectators[playerId] = { 
            name: `Spectator ${playerId.slice(-4)}`,
            playerId
        };
    }
    ws.send(JSON.stringify({ 
        type: 'init', 
        playerId, 
        role, 
        hostId, 
        players, 
        spectators, 
        foods,
        remainingFood,
        powerups,
        activeBombs,
        eliminatedPlayers,
        powerupTypes,
        gameRunning
    }));
    broadcast({ 
        type: 'updateLobby', 
        players, 
        spectators, 
        hostId,
        eliminatedPlayers,
        gameRunning
    });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (eliminatedPlayers[playerId] && 
                data.type !== 'setRole' && 
                data.type !== 'setName' && 
                data.type !== 'setColor' &&
                data.type !== 'chatMessage') {
                return;
            }
            // Handle direction change
            if (data.type === 'direction' && players[playerId]) {
                const player = players[playerId];
                if (player.activeEffects && player.activeEffects.frozen) {
                    return;
                }
                // Added mapping for WASD keys:
                let inputDir = data.direction;
                if (typeof inputDir === 'string') {
                    inputDir = inputDir.toLowerCase();
                    if (inputDir === 'w') inputDir = 'up';
                    else if (inputDir === 'a') inputDir = 'left';
                    else if (inputDir === 's') inputDir = 'down';
                    else if (inputDir === 'd') inputDir = 'right';
                }
                if (inputDir === 'up' && player.direction !== 'down') player.nextDirection = 'up';
                else if (inputDir === 'left' && player.direction !== 'right') player.nextDirection = 'left';
                else if (inputDir === 'down' && player.direction !== 'up') player.nextDirection = 'down';
                else if (inputDir === 'right' && player.direction !== 'left') player.nextDirection = 'right';
            } 
            // Handle shooting
            else if (data.type === 'shoot' && players[playerId] && players[playerId].bullets > 0) {
                const player = players[playerId];
                if (player.activeEffects && player.activeEffects.frozen) {
                    return;
                }
                player.bullets--;
                if (player.body.length > 0) {
                    const head = player.body[0];
                    player.activeBullets.push({
                        x: head.x,
                        y: head.y,
                        direction: player.direction,
                        ownerId: playerId
                    });
                }
            } 
            // Handle name change
            else if (data.type === 'setName' && data.name) {
                const name = data.name.trim().substring(0, 20);
                if (players[playerId]) {
                    players[playerId].name = name;
                } else if (spectators[playerId]) {
                    spectators[playerId].name = name;
                }
                broadcast({ 
                    type: 'updateLobby', 
                    players, 
                    spectators, 
                    hostId,
                    eliminatedPlayers,
                    gameRunning 
                });
            }
            // Handle color change
            else if (data.type === 'setColor' && data.color && players[playerId]) {
                const color = data.color;
                players[playerId].color = color;
                players[playerId].headColor = color;
                players[playerId].tailColor = lightenColor(color, 20);
                ws.send(JSON.stringify({
                    type: 'colorUpdated',
                    playerId,
                    color
                }));
                broadcast({ 
                    type: 'updateLobby', 
                    players, 
                    spectators, 
                    hostId,
                    eliminatedPlayers,
                    gameRunning 
                });
            }
            // Handle role change
            else if (data.type === 'setRole' && data.role) {
                if (gameRunning) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Cannot change roles during an active game'
                    }));
                    return;
                }
                if (data.role === 'Player' && Object.keys(players).length < MAX_PLAYERS) {
                    if (spectators[playerId]) {
                        const playerName = spectators[playerId].name;
                        delete spectators[playerId];
                        const baseColor = `#${Math.floor(Math.random() * 0xFFFFFF).toString(16).toString(16).padStart(6, '0')}`;
                        const lighterColor = lightenColor(baseColor, 20);
                        const darkerColor = baseColor;
                        players[playerId] = {
                            name: playerName,
                            body: [],
                            color: baseColor,
                            tailColor: lighterColor,
                            headColor: darkerColor,
                            direction: 'right',
                            nextDirection: 'right',
                            score: 0,
                            bullets: MAX_BULLETS,
                            activeBullets: [],
                            activeEffects: {},
                            playerId
                        };
                        adjustPlayerSpawn(playerId, Object.keys(players).length);
                    }
                } 
                else if (data.role === 'Spectator') {
                    if (players[playerId]) {
                        const playerName = players[playerId].name;
                        if (playerId === hostId) {
                            delete players[playerId];
                            assignNewHost();
                        } else {
                            delete players[playerId];
                        }
                        spectators[playerId] = { 
                            name: playerName,
                            playerId
                        };
                    }
                }
                broadcast({ 
                    type: 'updateLobby', 
                    players, 
                    spectators, 
                    hostId,
                    eliminatedPlayers,
                    gameRunning 
                });
                let newRole = players[playerId] ? 
                    (playerId === hostId ? 'Server Host' : 'Player') : 
                    'Spectator';
                ws.send(JSON.stringify({
                    type: 'roleUpdate',
                    role: newRole
                }));
            } 
            // Handle game start (host only)
            else if (data.type === 'startGame' && playerId === hostId && !gameRunning) {
                startGame();
            }
            // Handle pause game (host only)
            else if (data.type === 'pauseGame' && playerId === hostId) {
                pauseGame();
            }
            // Handle resume game (host only)
            else if (data.type === 'resumeGame' && playerId === hostId) {
                if (!gameRunning) {
                    gameRunning = true;
                    gameInterval = setInterval(updateGame, GAME_SPEED);
                    broadcast({ 
                        type: 'gameResumed', 
                        players, 
                        foods, 
                        spectators,
                        eliminatedPlayers,
                        powerups,
                        activeBombs,
                        remainingFood,
                        gameRunning: true,
                        hostId
                    });
                }
            }
            // Handle chat messages
            else if (data.type === 'chatMessage' && data.message) {
                const sanitizedMessage = data.message.substring(0, 100);
                const senderName = data.sender || 
                                  (players[playerId] ? players[playerId].name : 
                                  (spectators[playerId] ? spectators[playerId].name : 'Unknown'));
                broadcast({
                    type: 'chatMessage',
                    sender: senderName,
                    message: sanitizedMessage
                });
            }
        } catch (err) {
            console.error(`Error processing message from ${playerId}:`, err);
        }
    });

    ws.on('close', () => {
        console.log(`Client ${playerId} disconnected`);
        if (playerId === hostId) {
            delete players[playerId];
            assignNewHost();
            if (gameRunning) {
                pauseGame();
            }
        } else if (players[playerId]) {
            delete players[playerId];
            if (gameRunning && !eliminatedPlayers[playerId]) {
                eliminatePlayer(playerId, "disconnected");
            }
        } else if (spectators[playerId]) {
            delete spectators[playerId];
        }
        broadcast({ 
            type: 'updateLobby', 
            players, 
            spectators, 
            hostId,
            eliminatedPlayers,
            gameRunning 
        });
    });
});

// Update game state each tick
function updateGame() {
    if (!gameRunning) return;
    let justEliminated = [];
    trySpawnPowerup();
    Object.values(players).forEach(player => {
        if (eliminatedPlayers[player.playerId]) return;
        if (player.activeEffects && player.activeEffects.frozen) return;
        const moveCount = player.activeEffects && player.activeEffects.speedBoost ? 2 : 1;
        for (let moves = 0; moves < moveCount; moves++) {
            if (moves === 0) {
                player.direction = player.nextDirection;
            }
            if (player.body.length === 0) return;
            let newHead = { x: player.body[0].x, y: player.body[0].y };
            switch (player.direction) {
                case 'up': newHead.y--; break;
                case 'down': newHead.y++; break;
                case 'left': newHead.x--; break;
                case 'right': newHead.x++; break;
            }
            if (newHead.x < 0 || newHead.x >= GRID_COUNT || newHead.y < 0 || newHead.y >= GRID_COUNT) {
                if (player.activeEffects && player.activeEffects.shield) {
                    return;
                }
                if (eliminatePlayer(player.playerId, "hit the wall")) {
                    return;
                }
                justEliminated.push(player.playerId);
                return;
            }
            for (let i = 1; i < player.body.length; i++) {
                if (newHead.x === player.body[i].x && newHead.y === player.body[i].y) {
                    if (player.activeEffects && player.activeEffects.shield) {
                        return;
                    }
                    if (eliminatePlayer(player.playerId, "hit itself")) {
                        return;
                    }
                    justEliminated.push(player.playerId);
                    return;
                }
            }
            let collisionDetected = false;
            Object.values(players).forEach(otherPlayer => {
                if (otherPlayer !== player && !eliminatedPlayers[otherPlayer.playerId]) {
                    for (let i = 0; i < otherPlayer.body.length; i++) {
                        if (newHead.x === otherPlayer.body[i].x && newHead.y === otherPlayer.body[i].y) {
                            collisionDetected = true;
                            return;
                        }
                    }
                }
            });
            if (collisionDetected) {
                if (player.activeEffects && player.activeEffects.shield) {
                    return;
                }
                let possibleDirections = ['up', 'down', 'left', 'right'].filter(dir => {
                    if ((dir === 'up' && player.direction === 'down') ||
                        (dir === 'down' && player.direction === 'up') ||
                        (dir === 'left' && player.direction === 'right') ||
                        (dir === 'right' && player.direction === 'left')) {
                        return false;
                    }
                    let testHead = { x: player.body[0].x, y: player.body[0].y };
                    switch (dir) {
                        case 'up': testHead.y--; break;
                        case 'down': testHead.y++; break;
                        case 'left': testHead.x--; break;
                        case 'right': testHead.x++; break;
                    }
                    if (testHead.x < 0 || testHead.x >= GRID_COUNT || testHead.y < 0 || testHead.y >= GRID_COUNT) {
                        return false;
                    }
                    for (const p of Object.values(players)) {
                        if (!eliminatedPlayers[p.playerId]) {
                            for (const segment of p.body) {
                                if (testHead.x === segment.x && testHead.y === segment.y) {
                                    return false;
                                }
                            }
                        }
                    }
                    return true;
                });
                if (possibleDirections.length > 0) {
                    player.nextDirection = possibleDirections[Math.floor(Math.random() * possibleDirections.length)];
                    player.direction = player.nextDirection;
                    newHead = { x: player.body[0].x, y: player.body[0].y };
                    switch (player.direction) {
                        case 'up': newHead.y--; break;
                        case 'down': newHead.y++; break;
                        case 'left': newHead.x--; break;
                        case 'right': newHead.x++; break;
                    }
                } else {
                    if (eliminatePlayer(player.playerId, "got trapped")) {
                        return;
                    }
                    justEliminated.push(player.playerId);
                    return;
                }
            }
            let ateFood = false;
            for (let i = foods.length - 1; i >= 0; i--) {
                if (newHead.x === foods[i].x && newHead.y === foods[i].y) {
                    player.score += foods[i].type.value;
                    ateFood = true;
                    foods.splice(i, 1);
                    generateFood();
                    break;
                }
            }
            if (!ateFood) {
                for (let i = remainingFood.length - 1; i >= 0; i--) {
                    if (newHead.x === remainingFood[i].x && newHead.y === remainingFood[i].y) {
                        player.score += remainingFood[i].value || 1;
                        ateFood = true;
                        remainingFood.splice(i, 1);
                        break;
                    }
                }
            }
            for (let i = powerups.length - 1; i >= 0; i--) {
                if (newHead.x === powerups[i].x && newHead.y === powerups[i].y) {
                    const powerup = powerups[i];
                    player.score += 2;
                    powerups.splice(i, 1);
                    switch (powerup.type.id) {
                        case 'freeze':
                            applyFreezePowerup(player.playerId);
                            break;
                        case 'speed':
                            applySpeedPowerup(player.playerId);
                            break;
                        case 'shield':
                            applyShieldPowerup(player.playerId);
                            break;
                        case 'magnet':
                            applyMagnetPowerup(player.playerId);
                            break;
                        case 'bomb':
                            plantBomb(player.playerId);
                            break;
                    }
                    break;
                }
            }
            player.body.unshift(newHead);
            if (!ateFood) player.body.pop();
        }
        if (player.activeEffects && player.activeEffects.magnet && player.body.length > 0) {
            const head = player.body[0];
            const magnetRadius = player.activeEffects.magnet.radius;
            foods.forEach(food => {
                const dx = head.x - food.x;
                const dy = head.y - food.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < magnetRadius) {
                    let moveX = dx / distance;
                    let moveY = dy / distance;
                    if (Math.random() < 0.3) {
                        const newFoodX = food.x + Math.sign(moveX);
                        if (newFoodX >= 0 && newFoodX < GRID_COUNT) {
                            food.x = newFoodX;
                        }
                        const newFoodY = food.y + Math.sign(moveY);
                        if (newFoodY >= 0 && newFoodY < GRID_COUNT) {
                            food.y = newFoodY;
                        }
                    }
                }
            });
            remainingFood.forEach(food => {
                const dx = head.x - food.x;
                const dy = head.y - food.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < magnetRadius) {
                    let moveX = dx / distance;
                    let moveY = dy / distance;
                    if (Math.random() < 0.3) {
                        const newFoodX = food.x + Math.sign(moveX);
                        if (newFoodX >= 0 && newFoodX < GRID_COUNT) {
                            food.x = newFoodX;
                        }
                        const newFoodY = food.y + Math.sign(moveY);
                        if (newFoodY >= 0 && newFoodY < GRID_COUNT) {
                            food.y = newFoodY;
                        }
                    }
                }
            });
        }
    });
    Object.values(players).forEach(player => {
        if (eliminatedPlayers[player.playerId]) return;
        for (let i = player.activeBullets.length - 1; i >= 0; i--) {
            const bullet = player.activeBullets[i];
            for (let j = 0; j < 2; j++) {
                switch (bullet.direction) {
                    case 'up': bullet.y--; break;
                    case 'down': bullet.y++; break;
                    case 'left': bullet.x--; break;
                    case 'right': bullet.x++; break;
                }
                if (bullet.x < 0 || bullet.x >= GRID_COUNT || bullet.y < 0 || bullet.y >= GRID_COUNT) {
                    player.activeBullets.splice(i, 1);
                    break;
                }
                for (const [targetId, target] of Object.entries(players)) {
                    if (targetId !== bullet.ownerId && !eliminatedPlayers[targetId]) {
                        for (let k = 0; k < target.body.length; k++) {
                            if (bullet.x === target.body[k].x && bullet.y === target.body[k].y) {
                                if (target.activeEffects && target.activeEffects.shield) {
                                    player.activeBullets.splice(i, 1);
                                    break;
                                }
                                if (k === 0) {
                                    player.score += 10;
                                    player.activeBullets.splice(i, 1);
                                    if (eliminatePlayer(targetId, `was shot in the head by ${player.name}`)) {
                                        return;
                                    }
                                    justEliminated.push(targetId);
                                    return;
                                } else {
                                    player.score += 5;
                                    target.body.splice(k);
                                    if (target.body.length <= 1) {
                                        if (eliminatePlayer(targetId, `was reduced to nothing by ${player.name}`)) {
                                            return;
                                        }
                                        justEliminated.push(targetId);
                                    }
                                    player.activeBullets.splice(i, 1);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    });
    foods.forEach(food => {
        food.pulse = (food.pulse + food.pulseDelta) % 0.3;
        if (food.pulse > 0.15) food.pulseDelta = -0.05;
        if (food.pulse < 0) food.pulseDelta = 0.05;
    });
    powerups.forEach(powerup => {
        powerup.pulse = (powerup.pulse + powerup.pulseDelta) % 0.5;
        if (powerup.pulse > 0.25) powerup.pulseDelta = -0.05;
        if (powerup.pulse < 0) powerup.pulseDelta = 0.05;
    });
    broadcast({ 
        type: 'update', 
        players, 
        foods, 
        spectators,
        eliminatedPlayers,
        remainingFood,
        powerups,
        activeBombs,
        gameRunning,
        hostId,
        justEliminated
    });
}

// Add a basic route for the root of the app
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', players: Object.keys(players).length, gameRunning });
});

// Start the server
server.listen(PORT, () => {
    console.log(`Snake Battle Server running on http://localhost:${PORT}`);
});

// Clean up on server shutdown
process.on('SIGINT', () => {
    console.log('Server shutting down...');
    if (gameInterval) clearInterval(gameInterval);
    if (bulletRefillInterval) clearInterval(bulletRefillInterval);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.close(1000, 'Server shutting down');
        }
    });
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});