const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

// -------------------------------------------------------------
// Helper: Get Local LAN IPv4 Addresses
// -------------------------------------------------------------
function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];
    for (const devName in interfaces) {
        const ifaceList = interfaces[devName];
        for (const iface of ifaceList) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push({ name: devName, address: iface.address });
            }
        }
    }
    return ips;
}

// -------------------------------------------------------------
// HTTP Server (Static Files & API)
// -------------------------------------------------------------
const MIME_TYPES = {
    '.html': 'text/html; charset=UTF-8',
    '.js': 'application/javascript; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.json': 'application/json; charset=UTF-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    let pathname = parsedUrl.pathname;

    if (pathname === '/api/info') {
        const localIps = getLocalIPs();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({
            port: PORT,
            localIps: localIps.map(i => i.address),
            interfaces: localIps
        }));
        return;
    }

    if (pathname === '/' || pathname === '') {
        pathname = '/index.html';
    }

    const filePath = path.join(PUBLIC_DIR, pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            const fallbackPath = path.join(PUBLIC_DIR, 'index.html');
            if (fs.existsSync(fallbackPath)) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
                fs.createReadStream(fallbackPath).pipe(res);
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
                res.end('404 Not Found');
            }
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
    });
});

// -------------------------------------------------------------
// Official UNO Engine (108 Cards)
// -------------------------------------------------------------
const OFFICIAL_COLORS = [
    { name: "red", hex: "#C62828", ar: "أحمر" },
    { name: "blue", hex: "#1565C0", ar: "أزرق" },
    { name: "green", hex: "#2E7D32", ar: "أخضر" },
    { name: "yellow", hex: "#F9A825", ar: "أصفر" }
];

function create108UnoDeck() {
    const deck = [];
    let id = 1;
    OFFICIAL_COLORS.forEach(c => {
        deck.push({ id: id++, color: c.name, hex: c.hex, val: "0", type: "number" });
        for (let i = 1; i <= 9; i++) {
            deck.push({ id: id++, color: c.name, hex: c.hex, val: "" + i, type: "number" });
            deck.push({ id: id++, color: c.name, hex: c.hex, val: "" + i, type: "number" });
        }
        for (let k = 0; k < 2; k++) {
            deck.push({ id: id++, color: c.name, hex: c.hex, val: "🚫", type: "skip" });
            deck.push({ id: id++, color: c.name, hex: c.hex, val: "🔄", type: "reverse" });
            deck.push({ id: id++, color: c.name, hex: c.hex, val: "+2", type: "draw2" });
        }
    });

    for (let i = 0; i < 4; i++) {
        deck.push({ id: id++, color: "wild", hex: "#212121", val: "★", type: "wild" });
        deck.push({ id: id++, color: "wild", hex: "#212121", val: "+4", type: "wild4" });
    }
    shuffle(deck);
    return deck;
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function isValidPlay(cardData, currentTopCard, activeColor) {
    if (!currentTopCard) return true;
    if (cardData.color === "wild") return true;
    if (cardData.color === activeColor) return true;
    if (cardData.val === currentTopCard.val) return true;
    return false;
}

function generateRoomCode() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// -------------------------------------------------------------
// Room State Management
// -------------------------------------------------------------
const rooms = new Map();

class Room {
    constructor(code, hostSessionId, hostNickname, ws, isSolo = false) {
        this.code = code;
        this.hostSessionId = hostSessionId;
        this.isSolo = isSolo;
        this.status = 'waiting';
        this.players = [
            {
                seatIndex: 0,
                sessionId: hostSessionId,
                nickname: hostNickname || 'المضيف',
                isHost: true,
                isBot: false,
                connected: true,
                ws: ws,
                cards: []
            }
        ];
        this.deck = [];
        this.discardPile = [];
        this.currentTopCard = null;
        this.activeColor = null;
        this.currentTurn = 0;
        this.turnDirection = 1;
        this.pendingWild = null;
        this.botTimeout = null;
        this.createdAt = Date.now();
    }

    getPlayerBySession(sessionId) {
        return this.players.find(p => p.sessionId === sessionId);
    }

    broadcast(msg, excludeWs = null) {
        const payload = JSON.stringify(msg);
        this.players.forEach(p => {
            if (!p.isBot && p.ws && p.connected && p.ws.readyState === WebSocket.OPEN && p.ws !== excludeWs) {
                p.ws.send(payload);
            }
        });
    }

    getPublicPlayerList() {
        return this.players.map(p => ({
            seatIndex: p.seatIndex,
            nickname: p.nickname,
            isHost: p.isHost,
            isBot: p.isBot,
            connected: p.connected,
            cardCount: p.cards ? p.cards.length : 0
        }));
    }

    // Prevents running out of cards even in long games
    recycleDeck() {
        if (this.discardPile.length > 1) {
            const top = this.discardPile.pop();
            this.deck = [...this.discardPile];
            this.discardPile = [top];
            shuffle(this.deck);
        } else {
            // Edge case: all 108 cards are in players' hands
            // Generate a fresh deck so the game never freezes
            this.deck = create108UnoDeck();
        }
    }

    drawCard() {
        if (this.deck.length === 0) {
            this.recycleDeck();
        }
        let card = this.deck.pop();
        if (!card) {
            this.deck = create108UnoDeck();
            card = this.deck.pop();
        }
        return card;
    }

    destroy() {
        if (this.botTimeout) {
            clearTimeout(this.botTimeout);
            this.botTimeout = null;
        }
    }
}

// -------------------------------------------------------------
// WebSocket Game Server
// -------------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    let clientSessionId = null;
    let clientRoomCode = null;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            handleClientMessage(ws, msg);
        } catch (err) {
            console.error('Error handling WS message:', err);
        }
    });

    ws.on('close', () => {
        if (clientRoomCode && clientSessionId) {
            handleClientDisconnect(clientRoomCode, clientSessionId);
        }
    });

    function handleClientMessage(ws, msg) {
        const { type } = msg;

        // 1. إنشاء غرفة جديدة (Host)
        if (type === 'create_room') {
            const { nickname, sessionId } = msg;
            let code = generateRoomCode();
            while (rooms.has(code)) code = generateRoomCode();

            const room = new Room(code, sessionId, nickname, ws, false);
            rooms.set(code, room);
            clientSessionId = sessionId;
            clientRoomCode = code;

            ws.send(JSON.stringify({
                type: 'room_created',
                roomCode: code,
                mySeat: 0,
                isHost: true,
                nickname: room.players[0].nickname,
                players: room.getPublicPlayerList()
            }));
            return;
        }

        // 2. لعب سولو فوري ضد بوتات (Feature: Solo Against Bots)
        if (type === 'create_solo_game') {
            const { nickname, sessionId, targetTotalPlayers } = msg;
            let code = 'SOLO_' + generateRoomCode();
            while (rooms.has(code)) code = 'SOLO_' + generateRoomCode();

            const room = new Room(code, sessionId, nickname, ws, true);
            rooms.set(code, room);
            clientSessionId = sessionId;
            clientRoomCode = code;

            // Target players (between 2 and 8, default 4)
            let totalSeats = parseInt(targetTotalPlayers) || 4;
            totalSeats = Math.max(2, Math.min(8, totalSeats));

            // Fill all remaining seats with bots
            for (let seat = 1; seat < totalSeats; seat++) {
                room.players.push({
                    seatIndex: seat,
                    sessionId: `bot_${seat}_${Date.now()}`,
                    nickname: `بوت ${seat}`,
                    isHost: false,
                    isBot: true,
                    connected: true,
                    ws: null,
                    cards: []
                });
            }

            // Start game immediately
            startRoomGame(room);
            return;
        }

        // 3. الانضمام إلى غرفة (Guest)
        if (type === 'join_room') {
            const { roomCode, nickname, sessionId } = msg;
            const code = (roomCode || '').trim().toUpperCase();
            const room = rooms.get(code);

            if (!room) return sendError(ws, 'الغرفة غير موجودة. تأكد من الكود');
            if (room.status !== 'waiting') return sendError(ws, 'اللعبة بدأت بالفعل في هذه الغرفة');
            if (room.players.length >= 8) return sendError(ws, 'الغرفة ممتلئة (الحد الأقصى 8 لاعبين)');

            const existingPlayer = room.getPlayerBySession(sessionId);
            if (existingPlayer) {
                existingPlayer.ws = ws;
                existingPlayer.connected = true;
                clientSessionId = sessionId;
                clientRoomCode = code;

                ws.send(JSON.stringify({
                    type: 'room_joined',
                    roomCode: code,
                    mySeat: existingPlayer.seatIndex,
                    isHost: existingPlayer.isHost,
                    players: room.getPublicPlayerList()
                }));
                room.broadcast({ type: 'player_list_update', players: room.getPublicPlayerList() });
                return;
            }

            const newSeat = room.players.length;
            const playerObj = {
                seatIndex: newSeat,
                sessionId: sessionId,
                nickname: nickname || `لاعب ${newSeat + 1}`,
                isHost: false,
                isBot: false,
                connected: true,
                ws: ws,
                cards: []
            };

            room.players.push(playerObj);
            clientSessionId = sessionId;
            clientRoomCode = code;

            ws.send(JSON.stringify({
                type: 'room_joined',
                roomCode: code,
                mySeat: newSeat,
                isHost: false,
                players: room.getPublicPlayerList()
            }));

            room.broadcast({ type: 'player_list_update', players: room.getPublicPlayerList() });
            return;
        }

        // 4. إعادة الاتصال (Reconnection)
        if (type === 'reconnect') {
            const { roomCode, sessionId } = msg;
            const code = (roomCode || '').trim().toUpperCase();
            const room = rooms.get(code);
            if (!room) return sendError(ws, 'الغرفة غير متوفرة');

            const player = room.getPlayerBySession(sessionId);
            if (!player) return sendError(ws, 'لم يتم العثور على اللاعب في هذه الغرفة');

            player.ws = ws;
            player.connected = true;
            clientSessionId = sessionId;
            clientRoomCode = code;

            if (room.status === 'playing') {
                ws.send(JSON.stringify({
                    type: 'reconnected_state',
                    roomCode: code,
                    status: 'playing',
                    mySeat: player.seatIndex,
                    isHost: player.isHost,
                    totalPlayers: room.players.length,
                    players: room.getPublicPlayerList(),
                    myCards: player.cards,
                    currentTopCard: room.currentTopCard,
                    activeColor: room.activeColor,
                    currentTurn: room.currentTurn,
                    turnDirection: room.turnDirection,
                    placedCardsCount: room.discardPile.length,
                    pendingWildForMe: room.pendingWild && room.pendingWild.playerSeat === player.seatIndex
                }));

                room.broadcast({
                    type: 'player_status',
                    seatIndex: player.seatIndex,
                    connected: true,
                    nickname: player.nickname,
                    message: `${player.nickname} عاد إلى اللعبة`
                }, ws);
            } else {
                ws.send(JSON.stringify({
                    type: 'room_joined',
                    roomCode: code,
                    mySeat: player.seatIndex,
                    isHost: player.isHost,
                    players: room.getPublicPlayerList()
                }));
            }
            return;
        }

        const room = rooms.get(clientRoomCode);
        if (!room) return;
        const player = room.getPlayerBySession(clientSessionId);
        if (!player) return;

        // 5. بدء اللعبة (Host)
        if (type === 'start_game') {
            if (!player.isHost) return sendError(ws, 'المضيف فقط يمكنه بدء اللعبة');
            if (room.status === 'playing') return sendError(ws, 'اللعبة بدأت بالفعل');

            const { fillWithBots, targetTotalPlayers } = msg;
            let targetCount = parseInt(targetTotalPlayers) || room.players.length;
            targetCount = Math.max(2, Math.min(8, targetCount));

            if (fillWithBots && room.players.length < targetCount) {
                let botIdx = 1;
                while (room.players.length < targetCount) {
                    const seat = room.players.length;
                    room.players.push({
                        seatIndex: seat,
                        sessionId: `bot_${seat}_${Date.now()}`,
                        nickname: `بوت ${botIdx++}`,
                        isHost: false,
                        isBot: true,
                        connected: true,
                        ws: null,
                        cards: []
                    });
                }
            }

            if (room.players.length < 2) return sendError(ws, 'يجب توفر لاعبين على الأقل للبدء');
            startRoomGame(room);
            return;
        }

        // 6. رمي كرت (Play Card)
        if (type === 'play_card') {
            if (room.status !== 'playing' || room.currentTurn !== player.seatIndex || room.pendingWild) return;

            const { cardId, chosenColor } = msg;
            const cardIndex = player.cards.findIndex(c => c.id === cardId);
            if (cardIndex === -1) return sendError(ws, 'الكرت غير موجود بيدك');

            const card = player.cards[cardIndex];
            if (!isValidPlay(card, room.currentTopCard, room.activeColor)) {
                return sendError(ws, 'حركة غير مطابقة للون أو الرقم!');
            }

            if (card.color === 'wild' && !chosenColor) {
                room.pendingWild = { playerSeat: player.seatIndex, card };
                ws.send(JSON.stringify({ type: 'choose_color_request', cardId: card.id }));
                return;
            }

            player.cards.splice(cardIndex, 1);
            executeCardPlay(room, player, card, chosenColor);
            return;
        }

        // 7. اختيار لون بعد كرت Wild
        if (type === 'choose_color') {
            if (room.status !== 'playing' || !room.pendingWild || room.pendingWild.playerSeat !== player.seatIndex) return;
            const { chosenColor } = msg;
            const pending = room.pendingWild;
            room.pendingWild = null;

            const cIdx = player.cards.findIndex(c => c.id === pending.card.id);
            if (cIdx > -1) player.cards.splice(cIdx, 1);

            executeCardPlay(room, player, pending.card, chosenColor);
            return;
        }

        // 8. سحب كرت (Draw Card)
        if (type === 'draw_card') {
            if (room.status !== 'playing' || room.currentTurn !== player.seatIndex || room.pendingWild) return;
            executeCardDraw(room, player);
            return;
        }

        // 9. مغادرة الغرفة (Leave Room)
        if (type === 'leave_room') {
            handlePlayerLeave(room, player);
            return;
        }
    }

    function handleClientDisconnect(roomCode, sessionId) {
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.getPlayerBySession(sessionId);
        if (!player) return;

        player.connected = false;

        // Reassign host if disconnected player was host
        if (player.isHost) {
            const nextHost = room.players.find(p => !p.isBot && p.connected && p.sessionId !== sessionId);
            if (nextHost) {
                player.isHost = false;
                nextHost.isHost = true;
                room.hostSessionId = nextHost.sessionId;
                room.broadcast({
                    type: 'host_changed',
                    newHostSeat: nextHost.seatIndex,
                    newHostName: nextHost.nickname
                });
            }
        }

        if (room.status === 'playing') {
            room.broadcast({
                type: 'player_status',
                seatIndex: player.seatIndex,
                connected: false,
                nickname: player.nickname,
                message: `${player.nickname} انقطع اتصاله`
            });

            // Disconnect in player turn -> trigger bot fallback after 4 seconds
            if (room.currentTurn === player.seatIndex) {
                setTimeout(() => {
                    if (room.status === 'playing' && room.currentTurn === player.seatIndex && !player.connected) {
                        executeBotMoveForSeat(room, player);
                    }
                }, 4000);
            }
        } else {
            // Waiting lobby
            const pIdx = room.players.indexOf(player);
            if (pIdx > -1) {
                room.players.splice(pIdx, 1);
                room.players.forEach((p, i) => { p.seatIndex = i; });
            }
            if (room.players.length === 0) {
                room.destroy();
                rooms.delete(roomCode);
            } else {
                room.broadcast({ type: 'player_list_update', players: room.getPublicPlayerList() });
            }
        }
    }

    function handlePlayerLeave(room, player) {
        if (player.isHost) {
            const nextHost = room.players.find(p => !p.isBot && p.connected && p.sessionId !== player.sessionId);
            if (nextHost) {
                player.isHost = false;
                nextHost.isHost = true;
                room.hostSessionId = nextHost.sessionId;
                room.broadcast({
                    type: 'host_changed',
                    newHostSeat: nextHost.seatIndex,
                    newHostName: nextHost.nickname
                });
            }
        }

        if (room.status === 'playing') {
            player.isBot = true;
            player.connected = true;
            player.nickname = `${player.nickname} (بوت)`;
            room.broadcast({
                type: 'player_status',
                seatIndex: player.seatIndex,
                connected: true,
                nickname: player.nickname,
                replacedByBot: true,
                message: `${player.nickname} غادر اللعبة وعوضه بوت`
            });
            if (room.currentTurn === player.seatIndex) checkAndTriggerBotTurn(room);
        } else {
            const pIdx = room.players.indexOf(player);
            if (pIdx > -1) {
                room.players.splice(pIdx, 1);
                room.players.forEach((p, i) => { p.seatIndex = i; });
            }
            if (room.players.length === 0) {
                room.destroy();
                rooms.delete(room.code);
            } else {
                room.broadcast({ type: 'player_list_update', players: room.getPublicPlayerList() });
            }
        }
    }
});

function startRoomGame(room) {
    room.deck = create108UnoDeck();
    room.discardPile = [];
    room.players.forEach(p => { p.cards = []; });

    // 7 cards per player
    for (let i = 0; i < 7; i++) {
        room.players.forEach(p => p.cards.push(room.drawCard()));
    }

    // Top number card
    while (true) {
        const c = room.drawCard();
        if (c.type === 'number') {
            room.currentTopCard = c;
            room.activeColor = c.color;
            room.discardPile.push(c);
            break;
        } else {
            room.deck.unshift(c);
        }
    }

    room.status = 'playing';
    room.currentTurn = 0;
    room.turnDirection = 1;
    room.pendingWild = null;

    room.players.forEach(p => {
        if (!p.isBot && p.ws && p.connected && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({
                type: 'game_started',
                roomCode: room.code,
                mySeat: p.seatIndex,
                isHost: p.isHost,
                isSolo: room.isSolo,
                totalPlayers: room.players.length,
                players: room.getPublicPlayerList(),
                myHand: p.cards,
                currentTopCard: room.currentTopCard,
                activeColor: room.activeColor,
                currentTurn: room.currentTurn,
                turnDirection: room.turnDirection,
                placedCardsCount: room.discardPile.length
            }));
        }
    });

    checkAndTriggerBotTurn(room);
}

function sendError(ws, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message }));
    }
}

// -------------------------------------------------------------
// Card Play & Rules Resolution
// -------------------------------------------------------------
function executeCardPlay(room, player, card, chosenColor) {
    room.currentTopCard = card;
    room.activeColor = chosenColor || card.color;
    room.discardPile.push(card);

    const total = room.players.length;
    let step = room.turnDirection;
    let actionMsg = "";
    let penaltyPlayerSeat = null;
    let penaltyAmount = 0;

    if (card.type === "reverse") {
        if (total === 2) {
            // Reverse in 2-player UNO functions as a skip
            step = room.turnDirection * 2;
            actionMsg = "عكس اتجاه اللعب (تخطي) 🔄!";
        } else {
            room.turnDirection *= -1;
            step = room.turnDirection;
            actionMsg = "عكس اتجاه اللعب 🔄!";
        }
    } else if (card.type === "skip") {
        step = room.turnDirection * 2;
        actionMsg = "تخطي اللاعب الموالي 🚫!";
    } else if (card.type === "draw2") {
        penaltyPlayerSeat = (room.currentTurn + room.turnDirection + total * 4) % total;
        penaltyAmount = 2;
        step = room.turnDirection * 2;
        actionMsg = "سحب 2 كروت وإلغاء النوبة +2!";
    } else if (card.type === "wild4") {
        penaltyPlayerSeat = (room.currentTurn + room.turnDirection + total * 4) % total;
        penaltyAmount = 4;
        step = room.turnDirection * 2;
        actionMsg = "سحب 4 كروت وإلغاء النوبة +4!";
    }

    const isWin = player.cards.length === 0;
    if (isWin) room.status = 'game_over';

    const nextTurn = (room.currentTurn + step + total * 8) % total;
    const prevTurn = room.currentTurn;
    room.currentTurn = nextTurn;

    let penaltyCardsData = [];
    let penaltyPlayerCardCount = 0;
    if (penaltyPlayerSeat !== null && !isWin) {
        const penPlayer = room.players[penaltyPlayerSeat];
        for (let i = 0; i < penaltyAmount; i++) {
            const drawn = room.drawCard();
            penPlayer.cards.push(drawn);
            penaltyCardsData.push(drawn);
        }
        penaltyPlayerCardCount = penPlayer.cards.length;
    }

    room.players.forEach(p => {
        if (!p.isBot && p.ws && p.connected && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({
                type: 'card_played_broadcast',
                playerSeat: prevTurn,
                cardData: card,
                chosenColor: room.activeColor,
                activeColor: room.activeColor,
                playerCardCount: player.cards.length,
                turnDirection: room.turnDirection,
                actionMsg: actionMsg,
                nextTurn: room.currentTurn,
                penaltyPlayerSeat: penaltyPlayerSeat,
                penaltyAmount: penaltyAmount,
                penaltyPlayerCardCount: penaltyPlayerCardCount,
                penaltyCardsForMe: (p.seatIndex === penaltyPlayerSeat) ? penaltyCardsData : null,
                isWin: isWin,
                winnerSeat: isWin ? player.seatIndex : null,
                winnerName: isWin ? player.nickname : null,
                placedCardsCount: room.discardPile.length
            }));
        }
    });

    if (!isWin) checkAndTriggerBotTurn(room);
}

function executeCardDraw(room, player) {
    const total = room.players.length;
    const drawnCard = room.drawCard();
    player.cards.push(drawnCard);

    const prevTurn = room.currentTurn;
    const nextTurn = (room.currentTurn + room.turnDirection + total) % total;
    room.currentTurn = nextTurn;

    room.players.forEach(p => {
        if (!p.isBot && p.ws && p.connected && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({
                type: 'cards_drawn_broadcast',
                playerSeat: prevTurn,
                count: 1,
                playerCardCount: player.cards.length,
                drawnCardForMe: (p.seatIndex === prevTurn) ? drawnCard : null,
                nextTurn: room.currentTurn
            }));
        }
    });

    checkAndTriggerBotTurn(room);
}

function checkAndTriggerBotTurn(room) {
    if (room.status !== 'playing') return;
    if (room.botTimeout) {
        clearTimeout(room.botTimeout);
        room.botTimeout = null;
    }

    const currentP = room.players[room.currentTurn];
    if (currentP && (currentP.isBot || !currentP.connected)) {
        room.botTimeout = setTimeout(() => {
            if (room.status !== 'playing') return;
            executeBotMoveForSeat(room, currentP);
        }, 1200);
    }
}

function executeBotMoveForSeat(room, bot) {
    if (room.status !== 'playing' || room.currentTurn !== bot.seatIndex) return;
    const playableIdx = bot.cards.findIndex(c => isValidPlay(c, room.currentTopCard, room.activeColor));

    if (playableIdx !== -1) {
        const card = bot.cards.splice(playableIdx, 1)[0];
        let chosenColor = card.color;
        if (card.color === 'wild') {
            const counts = { red: 0, blue: 0, green: 0, yellow: 0 };
            bot.cards.forEach(c => { if (counts[c.color] !== undefined) counts[c.color]++; });
            chosenColor = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
        }
        executeCardPlay(room, bot, card, chosenColor);
    } else {
        executeCardDraw(room, bot);
    }
}

server.listen(PORT, '0.0.0.0', () => {
    const localIPs = getLocalIPs();
    console.log('====================================================');
    console.log('🎮 سيرفر أونو 3D المحلي (UNO 3D LAN Server) يعمل بنجاح!');
    console.log('====================================================');
    console.log(`🌐 محلياً على هذا الجهاز: http://localhost:${PORT}`);
    if (localIPs.length > 0) {
        console.log('📲 للعب مع الهواتف والأجهزة الأخرى على نفس شبكة الواي فاي:');
        localIPs.forEach(ip => {
            console.log(`   👉 http://${ip.address}:${PORT} (${ip.name})`);
        });
    }
    console.log('====================================================');
});
