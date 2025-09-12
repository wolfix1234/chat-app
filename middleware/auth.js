import jwt from "jsonwebtoken";

export const socketAuth = (socket, next) => {
  const token = socket.handshake.auth.token;
  
  if (!token) {
    return next(new Error("Authentication required"));
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const adminRoles = ["admin", "superadmin"];
    const userType = adminRoles.includes(decoded.role) ? "admin" : "user";
    
    socket.userName = decoded.name;
    socket.sessionId = decoded.id;
    socket.userId = decoded.id;
    socket.userType = userType;
    socket.userRole = decoded.role;
    next();
  } catch (err) {
    console.error("JWT verification failed:", err.message);
    return next(new Error("Invalid token"));
  }
};