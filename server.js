const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ルート（/）にアクセスしたときは entrance.html を開く
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'entrance.html'));
});

const PORT = process.env.PORT || 3000;
const P1_TARGET_CORNERS = ['0,0', '0,5'];
const P2_TARGET_CORNERS = ['5,0', '5,5'];

const rooms = {};

function createGameState() {
  return {
    board: Array(6).fill(null).map(() => Array(6).fill(null)),
    turn: 'p1',
    phase: 'setup', // 'setup' | 'playing' | 'ended'
    players: {
      p1: { id: null, ready: false, setup: null },
      p2: { id: null, ready: false, setup: null }
    },
    exiled: {
      p1: { catcher: 0, nonCatcher: 0 },
      p2: { catcher: 0, nonCatcher: 0 }
    },
    winner: null,
    winReason: ''
  };
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join_room', (roomId) => {
    currentRoom = roomId || 'default';
    socket.join(currentRoom);

    if (!rooms[currentRoom]) {
      rooms[currentRoom] = createGameState();
    }

    const state = rooms[currentRoom];

    // 空いている役割に割り当て
    if (!state.players.p1.id) {
      state.players.p1.id = socket.id;
    } else if (!state.players.p2.id && state.players.p1.id !== socket.id) {
      state.players.p2.id = socket.id;
    }

    broadcastState(currentRoom);
  });

  socket.on('submit_setup', (setupArray) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const state = rooms[currentRoom];
    if (state.phase !== 'setup') return;

    const role = getRole(state, socket.id);
    if (role !== 'p1' && role !== 'p2') return;

    if (!Array.isArray(setupArray) || setupArray.length !== 8) return;
    const catcherCount = setupArray.filter(v => v === true).length;
    if (catcherCount !== 4) return;

    state.players[role].setup = setupArray;
    state.players[role].ready = true;

    // 双方の準備完了で対戦開始
    if (state.players.p1.ready && state.players.p2.ready) {
      applySetupToBoard(state);
      state.phase = 'playing';
    }

    broadcastState(currentRoom);
  });

  socket.on('move_piece', ({ from, to }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const state = rooms[currentRoom];
    if (state.phase !== 'playing') return;

    const role = getRole(state, socket.id);
    // 自分の手番でない場合は無視
    if (role !== state.turn) return;

    const [fromR, fromC] = [from.r, from.c];
    const [toR, toC] = [to.r, to.c];

    const piece = state.board[fromR][fromC];
    if (!piece || piece.owner !== role) return;

    // 1マス移動チェック
    const dr = Math.abs(fromR - toR);
    const dc = Math.abs(fromC - toC);
    if (!((dr === 1 && dc === 0) || (dr === 0 && dc === 1))) return;

    const target = state.board[toR][toC];
    if (target && target.owner === role) return;

    // 相手駒の追い出し
    if (target && target.owner !== role) {
      if (role === 'p1') {
        target.isCatcher ? state.exiled.p1.catcher++ : state.exiled.p1.nonCatcher++;
      } else {
        target.isCatcher ? state.exiled.p2.catcher++ : state.exiled.p2.nonCatcher++;
      }
    }

    state.board[toR][toC] = piece;
    state.board[fromR][fromC] = null;

    // 勝利判定1: 追い出し
    if (checkExileWin(state)) {
      broadcastState(currentRoom);
      return;
    }

    // 手番交代
    state.turn = state.turn === 'p1' ? 'p2' : 'p1';

    // 勝利判定2: ネズミ捕獲（手番開始時判定）
    if (checkCornerCaptureWin(state)) {
      broadcastState(currentRoom);
      return;
    }

    broadcastState(currentRoom);
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const state = rooms[currentRoom];

    if (state.players.p1.id === socket.id) {
      state.players.p1.id = null;
    } else if (state.players.p2.id === socket.id) {
      state.players.p2.id = null;
    }

    // 対戦中でない（準備中）かつ全員抜けたら部屋を削除
    if (state.phase === 'setup' && !state.players.p1.id && !state.players.p2.id) {
      delete rooms[currentRoom];
    }
    // ※対戦中(playing)の場合は切断されても盤面を維持し、再接続を待つ
  });

  socket.on('send_chat', (messageText) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const state = rooms[currentRoom];
    const role = getRole(state, socket.id);

    // 送信者の表示名を設定
    let senderName = '観戦者';
    if (role === 'p1') senderName = '白猫(P1)';
    if (role === 'p2') senderName = '黒猫(P2)';

    const cleanText = String(messageText).trim().substring(0, 100); // 100文字制限
    if (!cleanText) return;

    // 部屋全員にチャットメッセージを送信
    io.to(currentRoom).emit('receive_chat', {
      sender: senderName,
      role: role,
      text: cleanText,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });
}); // ← ★ここに閉じるカッコが不足していました

function getRole(state, socketId) {
  if (state.players.p1.id === socketId) return 'p1';
  if (state.players.p2.id === socketId) return 'p2';
  return 'spectator';
}

function applySetupToBoard(state) {
  let idx = 0;
  for (let r = 4; r <= 5; r++) {
    for (let c = 1; c <= 4; c++) {
      state.board[r][c] = { owner: 'p1', isCatcher: state.players.p1.setup[idx++] };
    }
  }
  idx = 0;
  for (let r = 0; r <= 1; r++) {
    for (let c = 1; c <= 4; c++) {
      state.board[r][c] = { owner: 'p2', isCatcher: state.players.p2.setup[idx++] };
    }
  }
}

function checkExileWin(state) {
  if (state.exiled.p1.nonCatcher >= 4) {
    endGame(state, 'p2', '白猫(P1)が捕らない猫を4匹全て追い出してしまいました！');
    return true;
  }
  if (state.exiled.p2.nonCatcher >= 4) {
    endGame(state, 'p1', '黒猫(P2)が捕らない猫を4匹全て追い出してしまいました！');
    return true;
  }
  if (state.exiled.p1.catcher >= 4) {
    endGame(state, 'p1', '白猫(P1)が相手の捕る猫を4匹全て追い出しました！');
    return true;
  }
  if (state.exiled.p2.catcher >= 4) {
    endGame(state, 'p2', '黒猫(P2)が相手の捕る猫を4匹全て追い出しました！');
    return true;
  }
  return false;
}

function checkCornerCaptureWin(state) {
  const targetCorners = state.turn === 'p1' ? P1_TARGET_CORNERS : P2_TARGET_CORNERS;
  for (const cornerKey of targetCorners) {
    const [r, c] = cornerKey.split(',').map(Number);
    const piece = state.board[r][c];
    if (piece && piece.owner === state.turn && piece.isCatcher) {
      const winnerName = state.turn === 'p1' ? '白猫(P1)' : '黒猫(P2)';
      endGame(state, state.turn, `${winnerName}がネズミの捕獲に成功しました！`);
      return true;
    }
  }
  return false;
}

function endGame(state, winnerRole, reason) {
  state.phase = 'ended';
  state.winner = winnerRole;
  state.winReason = reason;
}

function broadcastState(roomId) {
  const roomSockets = io.sockets.adapter.rooms.get(roomId);
  if (!roomSockets) return;

  const state = rooms[roomId];

  for (const socketId of roomSockets) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;

    const role = getRole(state, socketId);

    const clientBoard = state.board.map(row =>
      row.map(cell => {
        if (!cell) return null;
        const reveal = state.phase === 'ended' || cell.owner === role;
        return {
          owner: cell.owner,
          isCatcher: reveal ? cell.isCatcher : null
        };
      })
    );

    socket.emit('game_state', {
      board: clientBoard,
      turn: state.turn,
      phase: state.phase,
      myRole: role,
      p1Ready: state.players.p1.ready,
      p2Ready: state.players.p2.ready,
      exiled: state.exiled,
      winner: state.winner,
      winReason: state.winReason
    });
  }
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
