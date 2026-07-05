const express = require('express');
const router = express.Router();
const { uploadFileToGridFS } = require('../lib/gridfs');
const { requireCreatorUser } = require('../lib/creator-access');
const {
  ALL_EXTENSIONS,
  createMemoryUpload,
  getUploadErrorResponse,
  validateUploadedFile,
} = require('../lib/secure-upload');

const MAX_UPLOAD_SIZE = 250 * 1024 * 1024;
const upload = createMemoryUpload(MAX_UPLOAD_SIZE);

router.post('/', requireCreatorUser, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('Unknown upload error:', err);
      const response = getUploadErrorResponse(err, '250MB');
      return res.status(response.status).json(response.body);
    }
    next();
  });
}, async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const metadata = validateUploadedFile(file, { allowedExtensions: ALL_EXTENSIONS });
    
    const fileId = await uploadFileToGridFS(file.buffer, metadata.storageName, {
      originalName: metadata.originalName,
      uploadedBy: req.user.userId,
      uploadedAt: new Date(),
      contentType: metadata.contentType,
      size: metadata.size,
      extension: metadata.extension,
      category: metadata.category,
    });

    console.log('File uploaded to GridFS with ID:', fileId);
    const fileUrl = `/api/files/${fileId}`;
    console.log('File URL:', fileUrl);
    
    res.status(200).json({ 
      fileId,
      fileUrl,
      fileName: metadata.originalName,
      fileSize: metadata.size,
      fileType: metadata.contentType
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    const response = getUploadErrorResponse(error, '250MB');
    res.status(response.status).json(response.body);
  }
});

module.exports = router;
