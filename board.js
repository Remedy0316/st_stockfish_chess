/**
 * Chessboard UI - Custom CSS grid board with unicode pieces
 * Handles rendering, drag-and-drop, and click-click move input
 */

const PIECE_UNICODE = {
    wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙',
    bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟',
};

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];

export class ChessBoard {
    constructor(containerId, onMoveCallback) {
        this.container = null;
        this.containerId = containerId;
        this.onMoveCallback = onMoveCallback;
        this.selectedSquare = null;
        this.legalMoves = [];
        this.flipped = false;
        this.enabled = true;
        this.lastMove = null;
    }

    init() {
        this.container = document.getElementById(this.containerId);
        if (!this.container) return;
        this._buildBoard();
    }

    _buildBoard() {
        this.container.innerHTML = '';
        const board = document.createElement('div');
        board.className = 'chess-board-grid';

        const ranks = this.flipped ? [...RANKS].reverse() : RANKS;
        const files = this.flipped ? [...FILES].reverse() : FILES;

        for (let r = 0; r < 8; r++) {
            for (let f = 0; f < 8; f++) {
                const sq = files[f] + ranks[r];
                const isLight = (r + f) % 2 === 0;
                const cell = document.createElement('div');
                cell.className = `chess-square ${isLight ? 'light' : 'dark'}`;
                cell.dataset.square = sq;

                // Coordinate labels
                if (f === 0) {
                    const rankLabel = document.createElement('span');
                    rankLabel.className = 'coord-rank';
                    rankLabel.textContent = ranks[r];
                    cell.appendChild(rankLabel);
                }
                if (r === 7) {
                    const fileLabel = document.createElement('span');
                    fileLabel.className = 'coord-file';
                    fileLabel.textContent = files[f];
                    cell.appendChild(fileLabel);
                }

                cell.addEventListener('click', () => this._onSquareClick(sq));
                cell.addEventListener('dragover', (e) => e.preventDefault());
                cell.addEventListener('drop', (e) => this._onDrop(e, sq));

                board.appendChild(cell);
            }
        }

        this.container.appendChild(board);
    }

    render(game) {
        if (!this.container) return;
        const boardData = game.board();

        const ranks = this.flipped ? [...RANKS].reverse() : RANKS;
        const files = this.flipped ? [...FILES].reverse() : FILES;

        for (let r = 0; r < 8; r++) {
            for (let f = 0; f < 8; f++) {
                const sq = files[f] + ranks[r];
                const cell = this.container.querySelector(`[data-square="${sq}"]`);
                if (!cell) continue;

                // Remove existing piece
                const existingPiece = cell.querySelector('.chess-piece');
                if (existingPiece) existingPiece.remove();

                // Remove state classes
                cell.classList.remove('selected', 'legal-move', 'legal-capture', 'last-move', 'in-check');

                // Highlight last move
                if (this.lastMove && (sq === this.lastMove.from || sq === this.lastMove.to)) {
                    cell.classList.add('last-move');
                }

                // Get piece at this position
                const actualR = RANKS.indexOf(ranks[r]);
                const actualF = FILES.indexOf(files[f]);
                const piece = boardData[actualR][actualF];

                if (piece) {
                    const pieceEl = document.createElement('span');
                    pieceEl.className = `chess-piece ${piece.color === 'w' ? 'white-piece' : 'black-piece'}`;
                    pieceEl.textContent = PIECE_UNICODE[piece.color + piece.type];
                    pieceEl.draggable = this.enabled;
                    pieceEl.addEventListener('dragstart', (e) => {
                        e.dataTransfer.setData('text/plain', sq);
                        e.dataTransfer.effectAllowed = 'move';
                        // Highlight this square as selected after a small delay
                        setTimeout(() => this._showLegalMoves(sq), 0);
                    });
                    // Touch support (mobile Safari)
                    pieceEl.addEventListener('touchstart', (e) => {
                        if (!this.enabled) return;
                        e.preventDefault(); // Prevent text selection and delayed click
                        this._touchDragFrom = sq;
                        this._touchMoved = false;
                        this._showLegalMoves(sq);
                    });
                    pieceEl.addEventListener('touchmove', (e) => {
                        if (!this.enabled || !this._touchDragFrom) return;
                        e.preventDefault(); // Prevent scrolling while dragging a piece
                        this._touchMoved = true;
                    });
                    pieceEl.addEventListener('touchend', (e) => {
                        if (!this.enabled || !this._touchDragFrom) return;
                        e.preventDefault();
                        const touch = e.changedTouches[0];
                        const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
                        const targetCell = targetEl?.closest?.('[data-square]');
                        if (targetCell) {
                            const targetSq = targetCell.dataset.square;
                            if (this._touchDragFrom !== targetSq) {
                                // Dragged to a different square — attempt the move
                                this.selectedSquare = null;
                                this.legalMoves = [];
                                this.onMoveCallback({ from: this._touchDragFrom, to: targetSq });
                            }
                            // If same square and not dragged, the piece stays selected
                            // (selection was already done in touchstart via _showLegalMoves)
                        }
                        this._touchDragFrom = null;
                    });
                    cell.appendChild(pieceEl);

                    // Highlight king in check
                    if (piece.type === 'k' && game.inCheck() && piece.color === game.turn()) {
                        cell.classList.add('in-check');
                    }
                }
            }
        }

        // Show selected square and legal moves
        if (this.selectedSquare) {
            this._highlightSelected();
        }
    }

    _onSquareClick(sq) {
        if (!this.enabled) return;

        if (this.selectedSquare) {
            // Try to make a move
            if (this.selectedSquare === sq) {
                this.selectedSquare = null;
                this.legalMoves = [];
                this._clearHighlights();
                this.onMoveCallback(null); // Signal deselect, re-render
                return;
            }

            const isLegal = this.legalMoves.some(m => m.to === sq);
            if (isLegal) {
                const move = { from: this.selectedSquare, to: sq };
                this.selectedSquare = null;
                this.legalMoves = [];
                this.onMoveCallback(move);
            } else {
                // Click on a different piece = select it instead
                this.selectedSquare = null;
                this.legalMoves = [];
                this._showLegalMoves(sq);
            }
        } else {
            this._showLegalMoves(sq);
        }
    }

    _showLegalMoves(sq) {
        if (!this.enabled) return;
        // Will be populated by index.js providing legal moves
        this.selectedSquare = sq;
        this.onMoveCallback({ type: 'select', square: sq });
    }

    setLegalMoves(moves) {
        this.legalMoves = moves;
        this._highlightSelected();
    }

    _highlightSelected() {
        this._clearHighlights();
        if (!this.selectedSquare) return;

        const selCell = this.container.querySelector(`[data-square="${this.selectedSquare}"]`);
        if (selCell) selCell.classList.add('selected');

        for (const move of this.legalMoves) {
            const cell = this.container.querySelector(`[data-square="${move.to}"]`);
            if (cell) {
                cell.classList.add(move.captured ? 'legal-capture' : 'legal-move');
            }
        }
    }

    _clearHighlights() {
        if (!this.container) return;
        this.container.querySelectorAll('.selected, .legal-move, .legal-capture').forEach(el => {
            el.classList.remove('selected', 'legal-move', 'legal-capture');
        });
    }

    _onDrop(e, targetSq) {
        e.preventDefault();
        if (!this.enabled) return;

        const fromSq = e.dataTransfer.getData('text/plain');
        if (fromSq && fromSq !== targetSq) {
            this.selectedSquare = null;
            this.legalMoves = [];
            this.onMoveCallback({ from: fromSq, to: targetSq });
        }
    }

    flip() {
        this.flipped = !this.flipped;
        this._buildBoard();
    }

    setEnabled(enabled) {
        this.enabled = enabled;
    }
}
