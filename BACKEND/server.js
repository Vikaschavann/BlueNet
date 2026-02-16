const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");



const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "../FRONTEND")));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

// Room storage
const rooms = {};

io.on("connection", (socket) => {
  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    socket.to(roomId).emit("user-joined", socket.id);

    socket.on("signal", (data) => {
      io.to(data.to).emit("signal", {
        from: socket.id,
        signal: data.signal,
      });
    });
  });
});


server.listen(3000, () => {
  console.log("Server running on port 3000");
});
