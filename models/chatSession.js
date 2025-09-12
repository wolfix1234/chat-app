import mongoose from 'mongoose';

const chatSessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userId: {
    type: String,
    required: true
  },
  userName: {
    type: String,
    required: true
  },
  userType: {
    type: String,
    enum: ['guest', 'user'],
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  lastActivity: {
    type: Date,
    default: Date.now,
    index: true
  },
  adminVisibility: {
    type: Date,
    default: Date.now // When this session should be visible to admin (48h for users, 24h for guests)
  }
}, {
  timestamps: true
});

// Compound index for admin queries
chatSessionSchema.index({ adminVisibility: 1, userType: 1 });
chatSessionSchema.index({ createdAt: 1, userType: 1 });

export default mongoose.models.ChatSession || mongoose.model('ChatSession', chatSessionSchema);