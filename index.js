/**
 * SillyTavern Chess Extension - Stockfish AI Opponent
 *
 * Embeds an interactive chessboard in SillyTavern's UI.
 * Stockfish WASM runs client-side as the chess engine.
 * The LLM character comments on the game in character.
 */

import { Chess } from './lib/chess.js';
import { ChessBoard } from './board.js';
import { StockfishEngine } from './engine.js';

const MODULE_NAME = 'st_chess_stockfish';
const EXTENSION_FOLDER = 'third-party/st_stockfish_chess';

// --- Default Settings ---
const defaultSettings = Object.freeze({
    elo: 1350,
    playerColor: 'w',
    chatVerbosity: 'every', // 'every', 'key', 'silent'
    showEvaluation: true,
    moveDelay: 800,
    showMoveInChat: true,
    boardTheme: 'default',
});

// --- State ---
let game = null;
let board = null;
let engine = null;
let panelOpen = false;
let gameActive = false;
let isEngineThinking = false;
let playerResigned = false;
let moveHistory = [];
let extensionPath = '';

// --- Helpers ---

function getSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx.extensionSettings[MODULE_NAME]) {
        ctx.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    // Ensure all keys exist
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(ctx.extensionSettings[MODULE_NAME], key)) {
            ctx.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return ctx.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function getMetadata() {
    const ctx = SillyTavern.getContext();
    if (!ctx.chatMetadata[MODULE_NAME]) {
        ctx.chatMetadata[MODULE_NAME] = {};
    }
    return ctx.chatMetadata[MODULE_NAME];
}

async function saveMetadata() {
    await SillyTavern.getContext().saveMetadata();
}

function getEngineColor() {
    const settings = getSettings();
    return settings.playerColor === 'w' ? 'b' : 'w';
}

function getMaterialBalance(chessGame) {
    const values = { p: 1, n: 3, b: 3, r: 5, q: 9 };
    let whiteVal = 0, blackVal = 0;
    const boardData = chessGame.board();

    const whitePieces = { p: 0, n: 0, b: 0, r: 0, q: 0 };
    const blackPieces = { p: 0, n: 0, b: 0, r: 0, q: 0 };

    for (const row of boardData) {
        for (const sq of row) {
            if (!sq) continue;
            if (sq.type === 'k') continue;
            if (sq.color === 'w') {
                whiteVal += values[sq.type] || 0;
                whitePieces[sq.type]++;
            } else {
                blackVal += values[sq.type] || 0;
                blackPieces[sq.type]++;
            }
        }
    }

    const diff = whiteVal - blackVal;
    if (diff === 0) return 'Equal material';
    const side = diff > 0 ? 'White' : 'Black';
    const adv = Math.abs(diff);
    return `${side} is up by ${adv} point${adv !== 1 ? 's' : ''}`;
}

function getCapturedPieces(chessGame) {
    const initial = { p: 8, n: 2, b: 2, r: 2, q: 1 };
    const current = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };

    const boardData = chessGame.board();
    for (const row of boardData) {
        for (const sq of row) {
            if (!sq || sq.type === 'k') continue;
            current[sq.color][sq.type]++;
        }
    }

    const captured = { w: [], b: [] };
    const pieceUnicode = {
        w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕' },
        b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' },
    };

    for (const type of ['q', 'r', 'b', 'n', 'p']) {
        const wCaptured = initial[type] - current.w[type];
        const bCaptured = initial[type] - current.b[type];
        for (let i = 0; i < wCaptured; i++) captured.w.push(pieceUnicode.w[type]);
        for (let i = 0; i < bCaptured; i++) captured.b.push(pieceUnicode.b[type]);
    }

    return captured;
}

function getGameStatus(chessGame) {
    if (chessGame.isCheckmate()) {
        const loser = chessGame.turn();
        return loser === 'w' ? 'Checkmate — Black wins!' : 'Checkmate — White wins!';
    }
    if (chessGame.isStalemate()) return 'Stalemate — Draw';
    if (chessGame.isDraw()) return 'Draw';
    if (chessGame.inCheck()) {
        return `${chessGame.turn() === 'w' ? 'White' : 'Black'} is in check`;
    }
    return `${chessGame.turn() === 'w' ? 'White' : 'Black'} to move`;
}

function formatAlgebraic(moveObj) {
    if (!moveObj) return '';
    return moveObj.san || `${moveObj.from}-${moveObj.to}`;
}

function isKeyMoment(moveObj, chessGame) {
    if (!moveObj) return false;
    if (moveObj.captured) return true;
    if (chessGame.inCheck()) return true;
    if (chessGame.isCheckmate() || chessGame.isStalemate() || chessGame.isDraw()) return true;
    if (engine && engine.lastEval) {
        const absVal = Math.abs(engine.lastEval.value);
        if (engine.lastEval.type === 'mate') return true;
        if (absVal > 200) return true;
    }
    return false;
}

// --- Extension Path Detection ---

function detectExtensionPath() {
    // In SillyTavern, third-party extensions are at /scripts/extensions/third-party/<name>/
    extensionPath = `/scripts/extensions/${EXTENSION_FOLDER}`;
}

// --- Panel UI ---

function createPanel() {
    if (document.getElementById('chess-extension-panel')) return;

    console.log('[Chess Extension] Creating panel');

    const panel = document.createElement('div');
    panel.id = 'chess-extension-panel';
    panel.className = 'chess-extension-panel';
    panel.innerHTML = `
        <div class="chess-panel-header" id="chess-panel-header">
            <span class="chess-panel-title">♟ Chess</span>
            <div class="chess-panel-controls">
                <button id="chess-minimize-btn" class="chess-icon-btn" title="Minimize to floating button">−</button>
                <button id="chess-close-btn" class="chess-icon-btn" title="Close">✕</button>
            </div>
        </div>
        <div class="chess-panel-body" id="chess-panel-body">
            <div class="chess-status-bar" id="chess-status"></div>
            <div class="chess-captured" id="chess-captured-top"></div>
            <div id="chess-board-container" class="chess-board-container"></div>
            <div class="chess-captured" id="chess-captured-bottom"></div>
            <div class="chess-eval-bar" id="chess-eval-bar" style="display:none;">
                <div class="chess-eval-fill" id="chess-eval-fill"></div>
            </div>
            <div class="chess-move-history" id="chess-move-history"></div>
            <div class="chess-button-bar">
                <button id="chess-new-game-btn" class="chess-btn" title="New Game">New Game</button>
                <button id="chess-flip-btn" class="chess-btn" title="Flip Board">Flip</button>
                <button id="chess-takeback-btn" class="chess-btn" title="Take Back">Take Back</button>
                <button id="chess-resign-btn" class="chess-btn" title="Resign">Resign</button>
                <button id="chess-pgn-btn" class="chess-btn" title="Copy PGN">PGN</button>
            </div>
        </div>
    `;

    document.body.appendChild(panel);

    // Create floating minimize button
    createFloatingButton();

    // Make panel draggable
    makeDraggable(panel, document.getElementById('chess-panel-header'));

    // Button handlers
    document.getElementById('chess-close-btn').addEventListener('click', togglePanel);
    document.getElementById('chess-minimize-btn').addEventListener('click', minimizeToFloat);
    document.getElementById('chess-new-game-btn').addEventListener('click', startNewGame);
    document.getElementById('chess-flip-btn').addEventListener('click', flipBoard);
    document.getElementById('chess-takeback-btn').addEventListener('click', takeBack);
    document.getElementById('chess-resign-btn').addEventListener('click', resignGame);
    document.getElementById('chess-pgn-btn').addEventListener('click', copyPGN);

    // Initialize chessboard
    board = new ChessBoard('chess-board-container', handleBoardEvent);
    board.init();
}

function createFloatingButton() {
    if (document.getElementById('chess-floating-btn')) return;
    const btn = document.createElement('div');
    btn.id = 'chess-floating-btn';
    btn.className = 'chess-floating-btn';
    btn.title = 'Restore Chess Panel';
    btn.textContent = '♟';
    btn.style.display = 'none';
    btn.addEventListener('click', restoreFromFloat);
    document.body.appendChild(btn);
}

function minimizeToFloat() {
    const panel = document.getElementById('chess-extension-panel');
    const floatBtn = document.getElementById('chess-floating-btn');
    if (panel) panel.style.display = 'none';
    if (floatBtn) floatBtn.style.display = '';
}

function restoreFromFloat() {
    const panel = document.getElementById('chess-extension-panel');
    const floatBtn = document.getElementById('chess-floating-btn');
    if (panel) panel.style.display = '';
    if (floatBtn) floatBtn.style.display = 'none';
}

function makeDraggable(el, handle) {
    let offsetX = 0, offsetY = 0, isDragging = false;

    handle.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        isDragging = true;
        offsetX = e.clientX - el.offsetLeft;
        offsetY = e.clientY - el.offsetTop;
        el.style.transition = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const x = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, e.clientX - offsetX));
        const y = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, e.clientY - offsetY));
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        el.style.transition = '';
    });

    // Touch support for mobile
    handle.addEventListener('touchstart', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        const touch = e.touches[0];
        isDragging = true;
        offsetX = touch.clientX - el.offsetLeft;
        offsetY = touch.clientY - el.offsetTop;
        el.style.transition = 'none';
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const touch = e.touches[0];
        const x = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, touch.clientX - offsetX));
        const y = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, touch.clientY - offsetY));
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    }, { passive: true });

    document.addEventListener('touchend', () => {
        isDragging = false;
        el.style.transition = '';
    });
}

async function togglePanel() {
    try {
        const panel = document.getElementById('chess-extension-panel');
        const floatBtn = document.getElementById('chess-floating-btn');
        if (!panel) {
            createPanel();
            panelOpen = true;
            if (!gameActive) {
                // Don't let engine init failure prevent panel from showing
                startNewGame().catch(err => {
                    console.error('[Chess Extension] startNewGame failed:', err);
                    toastr.error('Chess engine failed to start. Try clicking New Game.');
                });
            }
            return;
        }

        panelOpen = !panelOpen;
        panel.style.display = panelOpen ? '' : 'none';
        // Hide floating button when panel is fully closed
        if (floatBtn && !panelOpen) floatBtn.style.display = 'none';
        if (!panelOpen) clearChessPrompt();

        if (panelOpen && !gameActive) {
            startNewGame().catch(err => {
                console.error('[Chess Extension] startNewGame failed:', err);
                toastr.error('Chess engine failed to start. Try clicking New Game.');
            });
        }
    } catch (err) {
        console.error('[Chess Extension] togglePanel error:', err);
        toastr.error('Chess panel error: ' + err.message);
    }
}

// --- Game Logic ---

async function startNewGame() {
    const settings = getSettings();

    game = new Chess();
    moveHistory = [];
    gameActive = true;
    isEngineThinking = false;
    playerResigned = false;

    // Initialize board
    if (board) {
        board.flipped = settings.playerColor === 'b';
        board.lastMove = null;
        board.selectedSquare = null;
        board.legalMoves = [];
        board._buildBoard();
        board.setEnabled(true);
        board.render(game);
    }

    // Initialize engine
    if (!engine) {
        engine = new StockfishEngine();
        try {
            await engine.init(extensionPath);
        } catch (err) {
            console.error('[Chess Extension] Failed to init Stockfish:', err);
            toastr.error('Failed to initialize Stockfish engine');
            return;
        }
    }

    engine.newGame();
    engine.configure({ elo: settings.elo, limitStrength: true });
    engine.onEvaluation = (eval_) => updateEvalBar(eval_);

    updateStatusUI();
    updateMoveHistoryUI();
    updateEvalBar({ type: 'cp', value: 0 });

    // Save game state
    const meta = getMetadata();
    meta.fen = game.fen();
    meta.pgn = game.pgn();
    meta.gameActive = true;
    meta.moveHistory = [];
    await saveMetadata();

    // If engine plays white, make the first move
    if (settings.playerColor === 'b') {
        await engineMove();
    }
}

async function handleBoardEvent(event) {
    if (!game || !gameActive || isEngineThinking) return;
    if (!event) {
        // Deselect - just re-render
        board.render(game);
        return;
    }

    const settings = getSettings();

    // Handle square selection
    if (event.type === 'select') {
        const sq = event.square;
        const piece = game.get(sq);
        if (piece && piece.color === settings.playerColor) {
            const moves = game.moves({ square: sq, verbose: true });
            board.selectedSquare = sq;
            board.setLegalMoves(moves);
            board.render(game);
        } else {
            board.selectedSquare = null;
            board.setLegalMoves([]);
            board.render(game);
        }
        return;
    }

    // Handle move attempt
    if (event.from && event.to) {
        // Only allow moves on player's turn
        if (game.turn() !== settings.playerColor) return;

        try {
            // Check if promotion is needed
            const piece = game.get(event.from);
            let promotion = undefined;
            if (piece && piece.type === 'p') {
                const targetRank = event.to[1];
                if ((piece.color === 'w' && targetRank === '8') || (piece.color === 'b' && targetRank === '1')) {
                    promotion = await showPromotionDialog();
                    if (!promotion) return; // Cancelled
                }
            }

            const move = game.move({
                from: event.from,
                to: event.to,
                promotion: promotion,
            });

            if (move) {
                board.lastMove = { from: move.from, to: move.to };
                board.selectedSquare = null;
                board.legalMoves = [];
                moveHistory.push(move);

                board.render(game);
                updateStatusUI();
                updateMoveHistoryUI();

                // Save state
                const meta = getMetadata();
                meta.fen = game.fen();
                meta.pgn = game.pgn();
                meta.moveHistory = moveHistory.map(m => m.san);
                await saveMetadata();

                // Send player move to chat
                if (settings.showMoveInChat && settings.chatVerbosity !== 'silent') {
                    await sendMoveToChat(move, 'player');
                }

                // Check game over
                if (game.isGameOver()) {
                    await handleGameOver();
                    return;
                }

                // Engine's turn
                await engineMove();
            }
        } catch (e) {
            // Invalid move - flash the board or something
            console.debug('[Chess Extension] Invalid move:', e.message);
            board.selectedSquare = null;
            board.legalMoves = [];
            board.render(game);
        }
    }
}

async function engineMove() {
    if (!engine || !game || game.isGameOver()) return;

    const settings = getSettings();
    isEngineThinking = true;
    board.setEnabled(false);
    updateStatusUI('Thinking...');

    try {
        // Calculate move time based on ELO
        const moveTime = Math.max(300, Math.min(3000, settings.elo));

        const bestMoveUCI = await engine.getBestMove(game.fen(), moveTime);

        if (!bestMoveUCI || bestMoveUCI === '(none)') {
            console.warn('[Chess Extension] Engine returned no move');
            isEngineThinking = false;
            board.setEnabled(true);
            return;
        }

        // Artificial delay for natural feel
        await new Promise(r => setTimeout(r, settings.moveDelay));

        // Parse UCI move (e.g., "e2e4" or "e7e8q")
        const from = bestMoveUCI.substring(0, 2);
        const to = bestMoveUCI.substring(2, 4);
        const promotion = bestMoveUCI.length > 4 ? bestMoveUCI[4] : undefined;

        const move = game.move({ from, to, promotion });

        if (move) {
            board.lastMove = { from: move.from, to: move.to };
            moveHistory.push(move);

            board.render(game);
            updateStatusUI();
            updateMoveHistoryUI();

            // Save state
            const meta = getMetadata();
            meta.fen = game.fen();
            meta.pgn = game.pgn();
            meta.moveHistory = moveHistory.map(m => m.san);
            await saveMetadata();

            // Send engine move to chat & trigger LLM response
            const shouldChat = settings.chatVerbosity === 'every' ||
                (settings.chatVerbosity === 'key' && isKeyMoment(move, game));

            if (shouldChat) {
                await triggerLLMResponse(move);
            }

            // Check game over
            if (game.isGameOver()) {
                await handleGameOver();
                return;
            }
        }
    } catch (err) {
        console.error('[Chess Extension] Engine move error:', err);
    } finally {
        isEngineThinking = false;
        board.setEnabled(true);
        updateStatusUI();
    }
}

async function handleGameOver() {
    board.setEnabled(false);

    const meta = getMetadata();
    meta.gameActive = false;
    meta.pgn = game.pgn();
    await saveMetadata();

    updateStatusUI();

    // Always trigger LLM response on game over
    const settings = getSettings();
    if (settings.chatVerbosity !== 'silent') {
        const status = getGameStatus(game);
        await sendSystemUserMessage(`*${status}*`);
        await triggerLLMResponse(null, true);
    }

    // Set gameActive false AFTER generation so the prompt injection has chess context
    gameActive = false;
    clearChessPrompt();
}

async function takeBack() {
    if (!game || !gameActive || isEngineThinking) return;

    // Undo engine's move and player's move
    const undone1 = game.undo();
    const undone2 = game.undo();

    if (undone1) moveHistory.pop();
    if (undone2) moveHistory.pop();

    board.lastMove = moveHistory.length > 0
        ? { from: moveHistory[moveHistory.length - 1].from, to: moveHistory[moveHistory.length - 1].to }
        : null;

    board.selectedSquare = null;
    board.legalMoves = [];
    board.render(game);
    updateStatusUI();
    updateMoveHistoryUI();

    const meta = getMetadata();
    meta.fen = game.fen();
    meta.pgn = game.pgn();
    meta.moveHistory = moveHistory.map(m => m.san);
    await saveMetadata();
}

async function resignGame() {
    if (!game || !gameActive || isEngineThinking) return;

    const ctx = SillyTavern.getContext();
    const confirmed = await ctx.Popup.show.confirm('Resign', 'Are you sure you want to resign?');
    if (!confirmed) return;

    board.setEnabled(false);
    playerResigned = true;
    updateStatusUI('You resigned');

    const meta = getMetadata();
    meta.gameActive = false;
    meta.resigned = true;
    await saveMetadata();

    const settings = getSettings();
    if (settings.chatVerbosity !== 'silent') {
        await sendSystemUserMessage('*{{user}} resigns the game.*');
        await triggerLLMResponse(null, true, 'resigned');
    }

    // Set gameActive false AFTER generation so the prompt injection has chess context
    gameActive = false;
    clearChessPrompt();
}

function flipBoard() {
    if (!board) return;
    board.flip();
    if (game) board.render(game);
}

async function copyPGN() {
    if (!game) return;
    try {
        await navigator.clipboard.writeText(game.pgn());
        toastr.success('PGN copied to clipboard');
    } catch (e) {
        toastr.error('Failed to copy PGN');
    }
}

async function showPromotionDialog() {
    const ctx = SillyTavern.getContext();
    const result = await ctx.Popup.show.input(
        'Promote Pawn',
        'Choose promotion piece:',
        'q',
    );
    if (!result) return null;
    const letter = result.trim().toLowerCase()[0];
    if (['q', 'r', 'b', 'n'].includes(letter)) return letter;
    return 'q';
}

// --- UI Updates ---

function updateStatusUI(override) {
    const el = document.getElementById('chess-status');
    if (!el || !game) return;

    if (override) {
        el.textContent = override;
        return;
    }

    el.textContent = getGameStatus(game);

    // Update captured pieces
    updateCapturedPiecesUI();
}

function updateCapturedPiecesUI() {
    const topEl = document.getElementById('chess-captured-top');
    const bottomEl = document.getElementById('chess-captured-bottom');
    if (!topEl || !bottomEl || !game) return;

    const captured = getCapturedPieces(game);
    const settings = getSettings();

    // When not flipped: Black at top, White at bottom
    // When flipped: White at top, Black at bottom
    // Show each side's lost pieces near their side of the board
    if (!board.flipped) {
        topEl.textContent = captured.b.join(' ');   // Black pieces lost
        bottomEl.textContent = captured.w.join(' '); // White pieces lost
    } else {
        topEl.textContent = captured.w.join(' ');    // White pieces lost
        bottomEl.textContent = captured.b.join(' '); // Black pieces lost
    }
}

function updateMoveHistoryUI() {
    const el = document.getElementById('chess-move-history');
    if (!el || !game) return;

    const history = game.history();
    let html = '';
    for (let i = 0; i < history.length; i += 2) {
        const moveNum = Math.floor(i / 2) + 1;
        const whiteMove = history[i] || '';
        const blackMove = history[i + 1] || '';
        html += `<span class="move-number">${moveNum}.</span> `;
        html += `<span class="move-white">${whiteMove}</span> `;
        if (blackMove) html += `<span class="move-black">${blackMove}</span> `;
    }
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
}

function updateEvalBar(eval_) {
    const settings = getSettings();
    const barEl = document.getElementById('chess-eval-bar');
    const fillEl = document.getElementById('chess-eval-fill');
    if (!barEl || !fillEl) return;

    barEl.style.display = settings.showEvaluation ? '' : 'none';

    if (!eval_) return;

    let pct;
    if (eval_.type === 'mate') {
        pct = eval_.value > 0 ? 100 : 0;
    } else {
        // Map centipawns to percentage (sigmoid-like)
        const cp = eval_.value;
        pct = 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
    }

    // If engine is black, invert
    const engineColor = getEngineColor();
    if (engineColor === 'b') pct = 100 - pct;

    fillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

// --- LLM Integration ---

function buildChessContext(lastMove, isGameOver) {
    if (!game) return '';

    const settings = getSettings();
    const engineColor = getEngineColor();
    const engineColorName = engineColor === 'w' ? 'White' : 'Black';
    const playerColorName = settings.playerColor === 'w' ? 'White' : 'Black';

    const history = game.history();
    const moveNum = Math.ceil(history.length / 2);
    const lastPlayerMove = moveHistory.findLast(m => m.color === settings.playerColor);
    const lastEngineMove = moveHistory.findLast(m => m.color === engineColor);

    let gameStatus;
    if (playerResigned) {
        gameStatus = `{{user}} (${playerColorName}) has resigned. You win!`;
    } else if (game.isCheckmate()) {
        const winner = game.turn() === settings.playerColor ? engineColorName : playerColorName;
        const loser = game.turn() === settings.playerColor ? playerColorName : engineColorName;
        gameStatus = `Checkmate! ${winner} wins. ${loser} has been checkmated.`;
    } else if (game.isStalemate()) {
        gameStatus = 'Stalemate — the game is a draw.';
    } else if (game.isDraw()) {
        gameStatus = 'The game is a draw.';
    } else if (game.inCheck()) {
        gameStatus = `${game.turn() === 'w' ? 'White' : 'Black'} is in check.`;
    } else {
        gameStatus = 'In progress.';
    }

    const evalDesc = engine ? engine.getEvalDescription(settings.playerColor, engineColor) : 'Unknown';

    let captureNote = '';
    if (lastMove && lastMove.captured) {
        const pieceName = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
        captureNote = `(captured a ${pieceName[lastMove.captured] || lastMove.captured})`;
    }

    return `[Chess Game State]
You are playing a chess game against {{user}}.
You are playing as: ${engineColorName}
Current position (FEN): ${game.fen()}
Move number: ${moveNum}
{{user}}'s last move: ${lastPlayerMove ? lastPlayerMove.san : 'None'} ${lastPlayerMove === lastMove ? captureNote : ''}
Your last move: ${lastEngineMove ? lastEngineMove.san : 'None'} ${lastEngineMove === lastMove ? captureNote : ''}
Material balance: ${getMaterialBalance(game)}
Position evaluation: ${evalDesc}
Game status: ${gameStatus}

Respond in character. You may comment on the game, react emotionally, strategize out loud, trash talk, or anything that fits your personality. Do not describe chess moves in exact notation unless it fits your character. Keep it natural.`;
}

async function triggerLLMResponse(lastMove, isGameOver = false, resignType = null) {
    const ctx = SillyTavern.getContext();
    if (!ctx.characterId && ctx.characterId !== 0) return;

    // For engine moves (not game over/resign which already sent a user message),
    // narrate the engine's move as a user message so the LLM has something to respond to
    if (lastMove && !isGameOver && !resignType) {
        const pieceName = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
        const piece = pieceName[lastMove.piece] || 'piece';
        const action = lastMove.captured ? 'captures on' : 'plays';
        const charName = ctx.characters[ctx.characterId]?.name || 'Opponent';
        await sendSystemUserMessage(`*${charName}'s ${piece} ${action} ${lastMove.to}*`);
    }

    try {
        // Inject chess game state as a system message via setExtensionPrompt
        updateChessPrompt(lastMove, isGameOver);

        await ctx.generate('normal');
    } catch (err) {
        console.error('[Chess Extension] Failed to trigger LLM response:', err);
    }
}

async function sendSystemUserMessage(text) {
    const ctx = SillyTavern.getContext();
    const msg = {
        is_user: true,
        name: ctx.name1 || 'User',
        mes: ctx.substituteParams(text),
        send_date: ctx.humanizedDateTime(),
        extra: { isChessMove: true },
    };
    ctx.chat.push(msg);
    await ctx.saveChat();
    ctx.addOneMessage(msg);
}

async function sendMoveToChat(move, source) {
    const settings = getSettings();
    if (!settings.showMoveInChat) return;

    const ctx = SillyTavern.getContext();

    const pieceName = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
    const piece = pieceName[move.piece] || 'piece';
    const action = move.captured ? 'captures on' : 'moves to';
    const label = source === 'player' ? '{{user}}' : (ctx.characters[ctx.characterId]?.name || 'Opponent');
    const text = `*${label}'s ${piece} ${action} ${move.to}${move.promotion ? ` (promotes to ${pieceName[move.promotion] || move.promotion})` : ''}*`;

    // Only send the player's move as a user message
    if (source === 'player') {
        const msg = {
            is_user: true,
            name: ctx.name1 || 'User',
            mes: ctx.substituteParams(text),
            send_date: ctx.humanizedDateTime(),
            extra: { isChessMove: true },
        };
        ctx.chat.push(msg);
        await ctx.saveChat();
        ctx.addOneMessage(msg);
    }
}

// --- Prompt Injection ---

function updateChessPrompt(lastMove, isGameOver) {
    const ctx = SillyTavern.getContext();
    if (!game || !gameActive) {
        ctx.setExtensionPrompt(MODULE_NAME, '', 1, 0, true, 0);
        return;
    }

    const chessContext = buildChessContext(lastMove, isGameOver);
    if (chessContext) {
        // Inject as a system message at depth 1 (before the last message)
        // Position 1 = IN_CHAT, Role 0 = SYSTEM
        ctx.setExtensionPrompt(MODULE_NAME, chessContext, 1, 1, true, 0);
    }
}

function clearChessPrompt() {
    try {
        const ctx = SillyTavern.getContext();
        ctx.setExtensionPrompt(MODULE_NAME, '', 1, 0, true, 0);
    } catch (e) {
        // Context may not be available yet
    }
}

// --- Settings Panel ---

async function createSettingsPanel() {
    const ctx = SillyTavern.getContext();
    const settings = getSettings();

    const settingsHtml = `
    <div class="chess-extension-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>♟ Chess - Stockfish</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="chess-settings-row">
                    <label for="chess_elo_slider">Difficulty (ELO): <span id="chess_elo_value">${settings.elo}</span></label>
                    <input id="chess_elo_slider" type="range" min="400" max="3000" step="50" value="${settings.elo}" />
                </div>
                <div class="chess-settings-row">
                    <label for="chess_player_color">Play as:</label>
                    <select id="chess_player_color">
                        <option value="w" ${settings.playerColor === 'w' ? 'selected' : ''}>White</option>
                        <option value="b" ${settings.playerColor === 'b' ? 'selected' : ''}>Black</option>
                    </select>
                </div>
                <div class="chess-settings-row">
                    <label for="chess_verbosity">Chat verbosity:</label>
                    <select id="chess_verbosity">
                        <option value="every" ${settings.chatVerbosity === 'every' ? 'selected' : ''}>Every move</option>
                        <option value="key" ${settings.chatVerbosity === 'key' ? 'selected' : ''}>Key moments only</option>
                        <option value="silent" ${settings.chatVerbosity === 'silent' ? 'selected' : ''}>Silent</option>
                    </select>
                </div>
                <div class="chess-settings-row">
                    <label for="chess_show_eval" class="chess-checkbox-label">
                        <input id="chess_show_eval" type="checkbox" ${settings.showEvaluation ? 'checked' : ''} />
                        Show evaluation bar
                    </label>
                </div>
                <div class="chess-settings-row">
                    <label for="chess_move_delay">Move delay (ms): <span id="chess_delay_value">${settings.moveDelay}</span></label>
                    <input id="chess_move_delay" type="range" min="0" max="3000" step="100" value="${settings.moveDelay}" />
                </div>
                <div class="chess-settings-row">
                    <label for="chess_show_move_chat" class="chess-checkbox-label">
                        <input id="chess_show_move_chat" type="checkbox" ${settings.showMoveInChat ? 'checked' : ''} />
                        Show moves in chat
                    </label>
                </div>
                <hr />
                <div class="chess-settings-row">
                    <button id="chess_open_panel_btn" class="menu_button">Open Chess Panel</button>
                </div>
            </div>
        </div>
    </div>`;

    jQuery('#extensions_settings2').append(settingsHtml);

    // Wire up settings events
    jQuery('#chess_elo_slider').on('input', function () {
        const val = parseInt(this.value, 10);
        jQuery('#chess_elo_value').text(val);
        getSettings().elo = val;
        saveSettings();
        if (engine && engine.ready) {
            engine.configure({ elo: val, limitStrength: true });
        }
    });

    jQuery('#chess_player_color').on('change', function () {
        getSettings().playerColor = this.value;
        saveSettings();
    });

    jQuery('#chess_verbosity').on('change', function () {
        getSettings().chatVerbosity = this.value;
        saveSettings();
    });

    jQuery('#chess_show_eval').on('change', function () {
        getSettings().showEvaluation = this.checked;
        saveSettings();
        const barEl = document.getElementById('chess-eval-bar');
        if (barEl) barEl.style.display = this.checked ? '' : 'none';
    });

    jQuery('#chess_move_delay').on('input', function () {
        const val = parseInt(this.value, 10);
        jQuery('#chess_delay_value').text(val);
        getSettings().moveDelay = val;
        saveSettings();
    });

    jQuery('#chess_show_move_chat').on('change', function () {
        getSettings().showMoveInChat = this.checked;
        saveSettings();
    });

    jQuery('#chess_open_panel_btn').on('click', () => {
        if (!panelOpen) togglePanel();
    });
}

// --- Restore Game State ---

async function restoreGameState() {
    try {
        const meta = getMetadata();
        if (meta.fen && meta.gameActive) {
            game = new Chess(meta.fen);
            gameActive = true;
            moveHistory = [];

            // Rebuild move history from PGN if available
            if (meta.pgn) {
                const tempGame = new Chess();
                try {
                    tempGame.loadPgn(meta.pgn);
                    moveHistory = tempGame.history({ verbose: true });
                } catch (e) {
                    console.warn('[Chess Extension] Could not restore move history from PGN:', e);
                }
            }

            if (board) {
                const settings = getSettings();
                board.flipped = settings.playerColor === 'b';
                if (moveHistory.length > 0) {
                    const lastM = moveHistory[moveHistory.length - 1];
                    board.lastMove = { from: lastM.from, to: lastM.to };
                }
                board._buildBoard();
                board.render(game);
                board.setEnabled(game.turn() === settings.playerColor);
            }

            updateStatusUI();
            updateMoveHistoryUI();

            console.log('[Chess Extension] Game state restored');
        }
    } catch (e) {
        console.warn('[Chess Extension] Could not restore game state:', e);
    }
}

// --- Initialization ---

jQuery(async () => {
    detectExtensionPath();
    await createSettingsPanel();

    // Add chess button to the extensions menu (wand area)
    const chessButton = jQuery(`
        <div id="chess-extension-button" class="list-group-item flex-container flexGap5" title="Open Chess Game">
            <div class="fa-solid fa-chess extensionsMenuExtensionButton"></div>
            Chess Game
        </div>
    `);

    // Find the extensions menu and add our button
    jQuery('#extensionsMenu').append(chessButton);

    chessButton.on('click', function (e) {
        e.stopPropagation();
        // Small delay to let mobile menu close animation finish
        setTimeout(() => togglePanel(), 50);
    });

    // Listen for chat changes to restore game state
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        if (panelOpen && board && game) {
            await restoreGameState();
        }
    });

    console.log('[Chess Extension] Loaded successfully');
});

// Export lifecycle hooks
export async function onActivate() {
    console.log('[Chess Extension] Activated');
}

export async function onInstall() {
    console.log('[Chess Extension] Installed');
    toastr.info('Chess Extension installed! Look for the chess icon in the extensions menu.');
}
