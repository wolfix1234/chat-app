import express from "express";
import { Server } from "socket.io";
import http from "http";
import minimist from "minimist";
import mongoose from "mongoose";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { socketAuth } from "./middleware/auth.js";

dotenv.config();

// Import models
import "./models/message.js";
import "./models/chatSession.js";

const argv = minimist(process.argv.slice(2));
const PORT = argv.p || process.env.PORT || 3500;
const HOST = argv.H || "0.0.0.0";

// Connect to MongoDB
if (process.env.MONGODB_URI) {
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch((err) => console.error("MongoDB connection error:", err));
}

const app = express();
app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
  const allowedOrigins = process.env.NODE_ENV === 'production' 
    ? ['https://oujamlak.ir', 'https://oujamlak.com']
    : ['http://localhost:3000'];
  
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// No need for duplicate auth routes - using NextJS JWT directly

// Test Socket.IO endpoint
// app.get('/socket.io/test', (req, res) => {
//   res.json({ message: 'Socket.IO server is running', timestamp: new Date().toISOString() });
// });


// just get the recent chat 
app.get("/api/admin/sessions", async (req, res) => {
  try {
    const ChatSession = mongoose.model("ChatSession");
    const now = new Date();
    
    const sessions = await ChatSession.find({
      adminVisibility: { $gte: now },
      userType: { $ne: 'admin' }
    })
    .sort({ lastActivity: -1 })
    .exec();
    
    res.json(sessions);
  } catch (error) {
    console.error("Error fetching admin sessions:", error);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// API: Get current user's message history
app.get("/api/messages/current", async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || !decoded.id) {
      return res.status(401).json({ error: "Invalid token" });
    }
    
    const Message = mongoose.model("Message");
    const messages = await Message.find({ sessionId: decoded.id })
      .sort({ createdAt: 1 })
      .limit(100)
      .exec();
    
    res.json(messages);
  } catch (error) {
    console.error("Error fetching current user messages:", error);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// API: Get session messages (for admin)
app.get("/api/messages/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const Message = mongoose.model("Message");
    const messages = await Message.find({ sessionId })
      .sort({ createdAt: 1 })
      .limit(100)
      .exec();

    res.json(messages);
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

const server = http.createServer(app);

// In-memory active users
const activeUsers = new Map();

const io = new Server(server, {
  path: '/socket.io/',
  cors: {
    origin: process.env.NODE_ENV === "production"
      ? ["https://oujamlak.ir", "https://oujamlak.com"]
      : ["http://localhost:3000", "http://localhost:3500", "http://127.0.0.1:3000", "http://127.0.0.1:3500", "http://localhost:3001"],
    methods: ["GET", "POST"],
    credentials: true
  },
  allowEIO3: true
});

server.listen(PORT, HOST, () => {});

io.use(socketAuth);

io.on("connection", (socket) => {
  
  activeUsers.set(socket.sessionId, {
    socketId: socket.id,
    userName: socket.userName,
    userType: socket.userType,
    sessionId: socket.sessionId,
    userId: socket.userId
  });
  
  socket.join(socket.sessionId);
  
  // If admin, join all active rooms
  if (socket.userType === 'admin') {
    activeUsers.forEach((user, sessionId) => {
      if (user.userType !== 'admin') {
        socket.join(sessionId);
      }
    });
  }
  
  createOrUpdateSession(socket);
  sendWelcomeIfNeeded(socket);
  notifyAdmins();

  socket.on("disconnect", () => {
    activeUsers.delete(socket.sessionId);
    notifyAdmins();
  });

  socket.on("message", async ({ text }) => {
    if (!text?.trim()) return;
    
    // Block unauthenticated users from sending messages
    if (!socket.userId) {
      return;
    }
    
    const messageData = {
      text: text.trim(),
      sessionId: socket.sessionId,
      userId: socket.userId,
      userName: socket.userName,
      userType: socket.userType,
      messageType: socket.userType === 'admin' ? 'admin' : 'user',
      time: new Intl.DateTimeFormat("default", {
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      }).format(new Date())
    };

    // Save to database
    try {
      const Message = mongoose.model("Message");
      await new Message(messageData).save();
      updateSessionActivity(socket.sessionId, socket.userType);
    } catch (error) {
      console.error("Error saving message:", error);
    }

    // Emit to room (includes user and any admins in the room)
    io.to(socket.sessionId).emit("message", {
      ...messageData,
      name: messageData.userName,
      room: socket.sessionId
    });
    
    // Notify all admins of new user message
    if (messageData.messageType === 'user') {
      io.emit("newUserMessage", {
        sessionId: socket.sessionId,
        userName: socket.userName,
        userType: socket.userType,
        preview: text.substring(0, 50)
      });
    }
  });

  socket.on("adminJoinRoom", ({ room }) => {
    socket.join(room);
    
    // Notify the room that admin joined
    socket.to(room).emit("adminJoined", {
      adminName: socket.userName || 'Admin',
      room: room
    });
  });

  socket.on("adminMessage", async ({ room, text, userName }) => {
    if (!room || !text?.trim()) return;
    
    const messageData = {
      text: text.trim(),
      sessionId: room,
      userId: "admin",
      userName: userName || "Admin",
      userType: "admin",
      messageType: "admin",
      time: new Intl.DateTimeFormat("default", {
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      }).format(new Date())
    };

    // Save admin messages to database
    try {
      const Message = mongoose.model("Message");
      await new Message(messageData).save();
      updateSessionActivity(room, 'admin');
    } catch (error) {
      console.error("Error saving admin message:", error);
    }

    // Send to the specific room
    io.to(room).emit("message", {
      ...messageData,
      name: messageData.userName,
      room: room
    });
  });
});

// Cleanup jobs
setInterval(cleanupExpiredSessions, 25 * 60 * 60 * 1000); // Every 25 hours clean the sessions
setInterval(cleanupExpiredMessages, 7 * 24 * 60 * 60 * 1000); // every 7 days clean old messages

// Helper functions
async function createOrUpdateSession(socket) {
  try {
    const ChatSession = mongoose.model("ChatSession");
    const now = new Date();
    
    // 48h admin visibility for all users
    const adminVisibilityExpiry = new Date(now);
    adminVisibilityExpiry.setHours(adminVisibilityExpiry.getHours() + 24);
    
    await ChatSession.findOneAndUpdate(
      { sessionId: socket.sessionId },
      {
        sessionId: socket.sessionId,
        userId: socket.userId,
        userName: socket.userName,
        userType: socket.userType,
        status: 'active',
        lastActivity: now,
        adminVisibility: adminVisibilityExpiry
      },
      { upsert: true, new: true }
    );
  } catch (error) {
    console.error("Error creating/updating session:", error);
  }
}

async function updateSessionActivity(sessionId, userType) {
  try {
    const ChatSession = mongoose.model("ChatSession");
    const now = new Date();
    
    // 48h admin visibility for all users
    const adminVisibilityExpiry = new Date(now);
    adminVisibilityExpiry.setHours(adminVisibilityExpiry.getHours() + 48);
    
    await ChatSession.findOneAndUpdate(
      { sessionId },
      { 
        lastActivity: now,
        adminVisibility: adminVisibilityExpiry
      }
    );
  } catch (error) {
    console.error("Error updating session activity:", error);
  }
}

async function sendWelcomeIfNeeded(socket) {
  try {
    // Only send welcome to users, not admins
    if (socket.userType === 'admin') {
      return;
    }
    
    const Message = mongoose.model("Message");
    const existingMessages = await Message.find({ sessionId: socket.sessionId }).limit(1);
    
    if (existingMessages.length === 0) {
      const welcomeMessage = {
        // text: socket.userId ? "خوش آمدید! چطور میتوانم امروز به شما کمک کنم؟" : "لطفا ابتدا ثبت نام کنید در سایت",
        text: "خوش آمدید! چطور میتوانم امروز به شما کمک کنم؟",
        sessionId: socket.sessionId,
        userId: "system",
        userName: "WhatsApp",
        userType: "admin",
        messageType: "system",
        time: new Intl.DateTimeFormat("default", {
          hour: "numeric",
          minute: "numeric",
          second: "numeric",
        }).format(new Date())
      };
      
      // Small delay to ensure socket is ready
      setTimeout(() => {
        socket.emit("message", welcomeMessage);
      }, 100);
    }
  } catch (error) {
    console.error("Error checking/sending welcome:", error);
  }
}

function notifyAdmins() {
  const activeSessions = Array.from(activeUsers.values())
    .filter(user => user.userType !== 'admin')
    .map(user => user.sessionId);
  
  // Send to all connected clients
  io.emit("roomList", { rooms: activeSessions });
  io.emit("activeSessionsList", { sessions: activeSessions });
}

async function cleanupExpiredSessions() {
  try {
    const ChatSession = mongoose.model("ChatSession");
    const now = new Date();
    
    // Remove sessions that are no longer visible to admin
    const result = await ChatSession.deleteMany({
      adminVisibility: { $lt: now }
    });
  } catch (error) {
    console.error("Session cleanup error:", error);
  }
}

async function cleanupExpiredMessages() {
  try {
    const Message = mongoose.model("Message");
    const now = new Date();
    
    // Delete messages older than 7 days
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 7);
    
    const messageResult = await Message.deleteMany({
      createdAt: { $lt: cutoff }
    });
  } catch (error) {
    console.error("Message cleanup error:", error);
  }
}