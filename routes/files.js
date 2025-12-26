const express = require('express');
const router = express.Router();
const { downloadFileFromGridFS } = require('../lib/gridfs');

// Handle OPTIONS requests for CORS preflight
router.options('/:id', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.status(204).end();
});

// GET a file by ID (public route - no authentication required for viewing course content)
router.get('/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    console.log('Attempting to retrieve file with ID:', fileId);
    console.log('Request headers:', req.headers);
    console.log('User-Agent:', req.headers['user-agent']);

    const fileData = await downloadFileFromGridFS(fileId);
    console.log('File retrieved successfully:', fileData.filename);
    console.log('Content-Type:', fileData.contentType);

    // Set CORS headers explicitly for iframe access
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('X-Content-Type-Options', 'nosniff');
    
    // Set appropriate headers
    if (fileData.contentType) {
      res.set('Content-Type', fileData.contentType);
    } else {
      // Default to application/octet-stream if content type is missing
      res.set('Content-Type', 'application/octet-stream');
    }
    
    // Set cache headers for better performance
    res.set('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
    
    // Set filename header for downloads
    if (fileData.filename) {
      // For images and PDFs, display inline; for other files, download
      const isImage = fileData.contentType && fileData.contentType.startsWith('image/');
      const isPDF = fileData.contentType === 'application/pdf';
      const disposition = (isImage || isPDF) ? 'inline' : 'attachment';
      res.set('Content-Disposition', `${disposition}; filename="${fileData.filename}"`);
    }

    // Send the file buffer
    res.send(fileData.buffer);
  } catch (error) {
    console.error('Error retrieving file:', error);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    if (error.message === 'Invalid file ID' || error.message === 'File not found') {
      return res.status(404).json({ error: 'File not found' });
    }
    
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

