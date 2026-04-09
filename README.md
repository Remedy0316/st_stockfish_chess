# SillyTavern Chess Extension — Stockfish AI

Play chess against Stockfish AI directly within SillyTavern! The AI character comments on the game in character while Stockfish handles all chess decisions.

## Features

- **Interactive Chessboard** — Custom CSS grid board with unicode pieces, drag-and-drop and tap-to-move input
- **Stockfish WASM** — Full chess engine running client-side in your browser (no server load)
- **Configurable Difficulty** — ELO slider from 400 to 3000
- **LLM Integration** — Your SillyTavern character reacts to the game in character via system prompt injection
- **Game State Persistence** — Games survive page refresh and chat switches
- **Draggable Panel** — Floating chess panel with touch and mouse drag support
- **Minimize to Floating Button** — Collapse the panel to a small ♟ icon to free up screen space, click to restore
- **Mobile Responsive** — Panel docks to the bottom on small screens; board and pieces scale to fit the viewport
- **Touch Support** — Full touch input for mobile browsers (tap-to-move and touch drag for pieces)

## Installation

1. Open SillyTavern
2. Go to **Extensions** → **Download Extensions & Assets**
3. Paste this repository URL and click install
4. Reload SillyTavern

## Usage

1. Click the **♟ Chess Game** button in the extensions menu (or the chess icon near the chat input)
2. The chess panel opens with a new game
3. Make moves by clicking/tapping or dragging pieces
4. Stockfish will respond with its move
5. Your character will comment on the game in chat
6. Click **−** to minimize the panel to a floating ♟ button; click the button to restore
7. Click **✕** to close the panel entirely

## Settings

Open **Extensions** → **Chess - Stockfish** settings to configure:

- **Difficulty (ELO)** — 400 (beginner) to 3000 (maximum)
- **Play as** — White or Black
- **Chat verbosity** — Every move / Key moments only / Silent
- **Show evaluation bar** — Toggle the position evaluation display
- **Move delay** — Artificial delay before engine moves (0-3000ms)
- **Show moves in chat** — Toggle move messages in the chat

## Panel Controls

- **New Game** — Start a fresh game
- **Flip** — Flip the board orientation
- **Take Back** — Undo your last move (and the engine's reply)
- **Resign** — Resign the current game
- **PGN** — Copy the game's PGN notation to clipboard
- **−** — Minimize panel to a floating ♟ icon
- **✕** — Close the panel

## How It Works

- **chess.js** handles all game logic and move validation
- **Stockfish WASM** (single-threaded lite build) runs in a Web Worker
- The LLM **never** makes chess decisions — it only generates flavor text
- Game context is injected as a **system prompt** via `setExtensionPrompt()` so the character can react appropriately

## Technical Notes

- Stockfish runs entirely in your browser — zero server load
- Uses single-threaded WASM build (no SharedArrayBuffer required)
- Stockfish WASM binary is ~7MB, loaded once on first game
- All libraries are bundled locally (no external CDN dependencies)
- Mobile responsive layout kicks in at viewport widths ≤ 600px
- Touch events are used alongside mouse events for full mobile browser compatibility (including Safari)

## License

AGPL-3.0
