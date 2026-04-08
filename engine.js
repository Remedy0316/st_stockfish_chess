/**
 * Stockfish Engine Wrapper
 * Runs Stockfish WASM in a Web Worker for non-blocking UI
 * Communicates via UCI protocol
 */

export class StockfishEngine {
    constructor() {
        this.worker = null;
        this.ready = false;
        this.thinking = false;
        this.onBestMove = null;
        this.onEvaluation = null;
        this.lastEval = { type: 'cp', value: 0, description: 'Equal' };
        this._resolveReady = null;
        this._readyPromise = null;
    }

    /**
     * Initialize the Stockfish Web Worker
     * @param {string} basePath - Path to the extension's directory
     */
    async init(basePath) {
        if (this.worker) {
            this.worker.terminate();
        }

        // The stockfish-18-lite-single.js can run as a Web Worker directly
        // The .wasm file is auto-resolved from the same directory
        const workerUrl = `${basePath}/vendor/stockfish-18-lite-single.js`;

        this._readyPromise = new Promise((resolve, reject) => {
            this._resolveReady = resolve;
            this._rejectReady = reject;
        });

        this.worker = new Worker(workerUrl);
        this.worker.onmessage = (e) => this._onMessage(e.data);
        this.worker.onerror = (e) => {
            console.error('[Chess Extension] Stockfish worker error:', e);
            if (this._rejectReady) {
                this._rejectReady(new Error('Stockfish worker failed to load'));
                this._rejectReady = null;
                this._resolveReady = null;
            }
        };

        // Send UCI initialization
        this._send('uci');
        await this._readyPromise;
        this.ready = true;
        console.log('[Chess Extension] Stockfish engine ready');
    }

    /**
     * Configure engine settings
     * @param {object} options - { elo: number, limitStrength: boolean }
     */
    configure({ elo = 1350, limitStrength = true } = {}) {
        if (!this.worker) return;
        this._send('setoption name UCI_LimitStrength value ' + (limitStrength ? 'true' : 'false'));
        this._send('setoption name UCI_Elo value ' + Math.max(400, Math.min(3000, elo)));
        this._send('setoption name Skill Level value ' + this._eloToSkillLevel(elo));
        this._send('isready');
    }

    /**
     * Map ELO to Stockfish Skill Level (0-20)
     */
    _eloToSkillLevel(elo) {
        if (elo <= 400) return 0;
        if (elo >= 3000) return 20;
        return Math.round(((elo - 400) / (3000 - 400)) * 20);
    }

    /**
     * Get the best move for a given position
     * @param {string} fen - The current FEN string
     * @param {number} moveTime - Time to think in ms
     * @returns {Promise<string>} - The best move in UCI notation (e.g., "e2e4")
     */
    async getBestMove(fen, moveTime = 1000) {
        if (!this.worker || !this.ready) {
            throw new Error('Engine not initialized');
        }

        this.thinking = true;
        this.lastEval = { type: 'cp', value: 0, description: 'Calculating...' };

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.thinking = false;
                this._send('stop');
                resolve(null);
            }, moveTime + 10000); // moveTime + generous buffer

            this.onBestMove = (move) => {
                clearTimeout(timeout);
                this.thinking = false;
                resolve(move);
            };

            this._send('position fen ' + fen);
            this._send('go movetime ' + moveTime);
        });
    }

    /**
     * Stop the current search
     */
    stop() {
        if (this.worker && this.thinking) {
            this._send('stop');
        }
    }

    /**
     * Reset the engine for a new game
     */
    newGame() {
        if (!this.worker) return;
        this._send('ucinewgame');
        this._send('isready');
        this.lastEval = { type: 'cp', value: 0, description: 'Equal' };
    }

    /**
     * Terminate the engine
     */
    destroy() {
        if (this.worker) {
            this._send('quit');
            this.worker.terminate();
            this.worker = null;
            this.ready = false;
        }
    }

    _send(cmd) {
        if (this.worker) {
            this.worker.postMessage(cmd);
        }
    }

    _onMessage(line) {
        if (typeof line !== 'string') return;

        // Engine ready signal
        if (line === 'uciok' || line === 'readyok') {
            if (this._resolveReady) {
                this._resolveReady();
                this._resolveReady = null;
            }
            return;
        }

        // Parse evaluation info
        if (line.startsWith('info') && line.includes('score')) {
            this._parseEvaluation(line);
        }

        // Parse best move
        if (line.startsWith('bestmove')) {
            const parts = line.split(' ');
            const move = parts[1];
            if (this.onBestMove) {
                this.onBestMove(move);
                this.onBestMove = null;
            }
        }
    }

    _parseEvaluation(line) {
        const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
        if (!scoreMatch) return;

        const type = scoreMatch[1];
        const value = parseInt(scoreMatch[2], 10);

        let description;
        if (type === 'mate') {
            if (value > 0) {
                description = `Mate in ${value} for the engine`;
            } else if (value < 0) {
                description = `Mate in ${Math.abs(value)} for the player`;
            } else {
                description = 'Checkmate';
            }
        } else {
            // Centipawn evaluation - from engine's perspective
            const cp = value;
            if (Math.abs(cp) < 25) description = 'Equal';
            else if (cp > 0 && cp < 100) description = 'Slightly better for the engine';
            else if (cp < 0 && cp > -100) description = 'Slightly better for the player';
            else if (cp >= 100 && cp < 300) description = 'Better for the engine';
            else if (cp <= -100 && cp > -300) description = 'Better for the player';
            else if (cp >= 300) description = 'The engine has a winning advantage';
            else description = 'The player has a winning advantage';
        }

        this.lastEval = { type, value, description };

        if (this.onEvaluation) {
            this.onEvaluation(this.lastEval);
        }
    }

    /**
     * Get evaluation description from a specific side's perspective
     * @param {string} playerColor - 'w' or 'b'
     * @param {string} engineColor - 'w' or 'b'
     */
    getEvalDescription(playerColor, engineColor) {
        const eval_ = this.lastEval;
        if (!eval_) return 'Unknown';

        if (eval_.type === 'mate') {
            if (eval_.value > 0) {
                return `Mate in ${eval_.value} for ${engineColor === 'w' ? 'White' : 'Black'}`;
            } else if (eval_.value < 0) {
                return `Mate in ${Math.abs(eval_.value)} for ${playerColor === 'w' ? 'White' : 'Black'}`;
            }
            return 'Checkmate';
        }

        // Stockfish reports from its own perspective
        const cp = eval_.value;
        const absCP = Math.abs(cp);
        let desc;
        if (absCP < 25) desc = 'Roughly equal';
        else if (absCP < 100) desc = 'Slight advantage';
        else if (absCP < 300) desc = 'Clear advantage';
        else desc = 'Winning advantage';

        if (absCP >= 25) {
            const winning = cp > 0 ? 'engine' : 'player';
            const winColor = winning === 'engine' ? engineColor : playerColor;
            desc += ` for ${winColor === 'w' ? 'White' : 'Black'}`;
        }

        return desc;
    }
}
