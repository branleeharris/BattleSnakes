# Multiplayer Snake Battle

A real-time multiplayer snake game with power-ups, shooting mechanics, and competitive gameplay.

## Features

- Real-time multiplayer gameplay with WebSockets
- Power-ups including freeze, speed boost, shield, magnet, and bombs
- Shooting mechanics to eliminate opponents
- Responsive design that works on desktop and mobile
- Lobby system with player/spectator roles

## Deployment Instructions

### Option 1: Deploy to Render.com (Recommended)

1. Create a GitHub repository and push all files maintaining this structure:
   ```
   snake-battle/
   ├── server.js
   ├── package.json
   ├── render.yaml
   ├── public/
   │   └── index.html
   ├── README.md
   ```

2. Sign up for [Render](https://render.com/)
   
3. Connect your GitHub repository to Render
   
4. Render will automatically detect the configuration from render.yaml and deploy your application
   
5. Share the provided URL with your office mates (e.g., https://snake-battle.onrender.com)

### Option 2: Manual Deployment on any Node.js Host

1. Clone or download this repository
   
2. Install Node.js (version 18 or higher recommended)
   
3. Install dependencies:
   ```
   npm install
   ```
   
4. Start the server:
   ```
   npm start
   ```
   
5. Access the game locally at http://localhost:8080
   
6. For public access, set up port forwarding on your router or deploy to a cloud provider

## Controls

- Use **W A S D** to move your snake
- Press **Q** to shoot (max 3 bullets, refills every minute)

## Game Rules

- Eat food to grow and gain points
- Different colored food gives different point values
- Shooting another snake's head is an instant kill
- Shooting a snake's body breaks it at that point
- Collect power-ups for special abilities
- Last snake standing wins!

## Development

To make local modifications:

1. Edit the game code in `server.js` for server-side logic
2. Edit the UI in `public/index.html` for client-side changes
3. Restart the server to apply changes

## License

This project is open-source and free to use for any purpose.
