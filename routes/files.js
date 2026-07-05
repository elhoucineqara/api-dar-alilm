const express = require('express');
const router = express.Router();
const { downloadFileFromGridFS } = require('../lib/gridfs');
const Section = require('../models/Section');
const Module = require('../models/Module');
const Course = require('../models/Course');
const { userCanAccessCourse } = require('../lib/course-access');
const { getOptionalAuthUser } = require('../lib/request-auth');

async function canAccessFile(req, fileId) {
  const section = await Section.findOne({ fileId }).lean();
  if (!section) {
    return true;
  }

  const module = await Module.findById(section.moduleId).lean();
  if (!module) {
    return false;
  }

  const course = await Course.findById(module.courseId).lean();
  if (!course) {
    return false;
  }

  const user = await getOptionalAuthUser(req, { allowQueryToken: true });
  return userCanAccessCourse({ user, course });
}

function getCorsOrigin(req) {
  return req.headers.origin || '*';
}

function getSafeDispositionFilename(filename) {
  return String(filename || 'file').replace(/[\r\n"]/g, '_');
}

// Handle OPTIONS requests for CORS preflight
router.options('/:id', (req, res) => {
  res.set('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Vary', 'Origin');
  res.status(204).end();
});

// GET a file by ID
router.get('/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    const hasAccess = await canAccessFile(req, fileId);

    if (!hasAccess) {
      return res.status(403).json({ error: 'File access denied' });
    }

    console.log('Attempting to retrieve file with ID:', fileId);
    console.log('Request headers:', req.headers);
    console.log('User-Agent:', req.headers['user-agent']);

    const fileData = await downloadFileFromGridFS(fileId);
    console.log('File retrieved successfully:', fileData.filename);
    console.log('Content-Type:', fileData.contentType);

    // Set CORS headers explicitly for iframe access
    res.set('Access-Control-Allow-Origin', getCorsOrigin(req));
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Vary', 'Origin');
    res.set('X-Content-Type-Options', 'nosniff');
    
    // Set appropriate headers
    if (fileData.contentType) {
      res.set('Content-Type', fileData.contentType);
    } else {
      // Default to application/octet-stream if content type is missing
      res.set('Content-Type', 'application/octet-stream');
    }
    
    // Course documents can be permissioned, so avoid long shared caches for them.
    const isDocument = fileData.metadata?.category === 'document';
    res.set('Cache-Control', isDocument ? 'private, max-age=300' : 'public, max-age=31536000');
    
    // Set filename header for downloads
    if (fileData.filename) {
      // For images and PDFs, display inline; for other files, download
      const isImage = fileData.contentType && fileData.contentType.startsWith('image/');
      const isPDF = fileData.contentType === 'application/pdf';
      const disposition = (isImage || isPDF) ? 'inline' : 'attachment';
      res.set('Content-Disposition', `${disposition}; filename="${getSafeDispositionFilename(fileData.filename)}"`);
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

