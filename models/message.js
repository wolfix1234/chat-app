import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  text: {
    type: String,
    required: true
  },
  sessionId: {
    type: String,
    required: true,
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
    enum: ['guest', 'user', 'admin'],
    required: true
  },
  messageType: {
    type: String,
    enum: ['user', 'admin', 'system'],
    default: 'user'
  },
  time: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

// Index for efficient cleanup queries
messageSchema.index({ createdAt: 1, userType: 1 });

export default mongoose.models.Message || mongoose.model('Message', messageSchema);