const express = require('express');
const router = express.Router();
const multer = require('multer');
const { uploadFileToGridFS } = require('../lib/gridfs');
const { verifyToken } = require('../lib/jwt');

const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB (increased from 10MB)
});

// Middleware to protect instructor routes
const isInstructor = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    const decoded = verifyToken(token);
    if (decoded.role !== 'instructor') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
};

router.post('/', isInstructor, (req, res, next) => {
  // Use multer's upload middleware
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      // A Multer error occurred when uploading
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      // An unknown error occurred when uploading
      console.error('Unknown upload error:', err);
      return res.status(500).json({ error: 'Internal server error during upload' });
    }
    // Everything went fine, proceed to the actual handler
    next();
  });
}, async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filename = `${timestamp}_${sanitizedName}`;
    
    const fileId = await uploadFileToGridFS(file.buffer, filename, {
      originalName: file.originalname,
      uploadedBy: req.user.userId,
      uploadedAt: new Date(),
      contentType: file.mimetype,
      size: file.size,
    });

    console.log('File uploaded to GridFS with ID:', fileId);
    const fileUrl = `/api/files/${fileId}`;
    console.log('File URL:', fileUrl);
    
    res.status(200).json({ 
      fileId,
      fileUrl,
      fileName: file.originalname,
      fileSize: file.size,
      fileType: file.mimetype
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
