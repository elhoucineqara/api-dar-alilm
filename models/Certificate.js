const mongoose = require('mongoose');

const CertificateSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  courseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Course',
    required: true,
  },
  certificateId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  studentName: {
    type: String,
    required: true,
  },
  courseName: {
    type: String,
    required: true,
  },
  instructorName: {
    type: String,
    required: true,
  },
  score: {
    type: Number,
    required: true,
  },
  completionDate: {
    type: Date,
    required: true,
  },
  issuedAt: {
    type: Date,
    default: Date.now,
  },
});

CertificateSchema.index({ studentId: 1, courseId: 1 }, { unique: true });

const Certificate = mongoose.models.Certificate || mongoose.model('Certificate', CertificateSchema);

module.exports = Certificate;
