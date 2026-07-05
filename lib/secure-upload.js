const crypto = require('crypto');
const path = require('path');
const multer = require('multer');

const MAX_INSPECT_BYTES = 4 * 1024 * 1024;

const FILE_TYPES = {
  pdf: {
    extensions: ['pdf'],
    contentType: 'application/pdf',
    category: 'document',
  },
  docx: {
    extensions: ['docx'],
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    category: 'document',
  },
  pptx: {
    extensions: ['pptx'],
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    category: 'document',
  },
  png: {
    extensions: ['png'],
    contentType: 'image/png',
    category: 'image',
  },
  jpeg: {
    extensions: ['jpg', 'jpeg'],
    contentType: 'image/jpeg',
    category: 'image',
  },
  gif: {
    extensions: ['gif'],
    contentType: 'image/gif',
    category: 'image',
  },
  webp: {
    extensions: ['webp'],
    contentType: 'image/webp',
    category: 'image',
  },
  mp4: {
    extensions: ['mp4', 'm4v'],
    contentType: 'video/mp4',
    category: 'video',
  },
  webm: {
    extensions: ['webm'],
    contentType: 'video/webm',
    category: 'video',
  },
  mov: {
    extensions: ['mov'],
    contentType: 'video/quicktime',
    category: 'video',
  },
};

const ALL_EXTENSIONS = Object.values(FILE_TYPES).flatMap((type) => type.extensions);
const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'pptx'];
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mov'];

function createUploadError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createMemoryUpload(maxSizeBytes) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSizeBytes },
  });
}

function sanitizeOriginalName(originalName = 'file') {
  const baseName = path.basename(originalName);
  const safeName = baseName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 140);

  return safeName || 'file';
}

function getExtension(filename = '') {
  return path.extname(filename).replace('.', '').toLowerCase();
}

function getTypeByExtension(extension) {
  return Object.values(FILE_TYPES).find((type) => type.extensions.includes(extension));
}

function hasHeader(buffer, header) {
  return header.every((byte, index) => buffer[index] === byte);
}

function readAscii(buffer) {
  return buffer.toString('latin1', 0, Math.min(buffer.length, MAX_INSPECT_BYTES));
}

function detectOpenXmlType(buffer) {
  const ascii = readAscii(buffer);

  if (!ascii.includes('[Content_Types].xml')) {
    return { detectedType: 'zip' };
  }

  if (ascii.includes('vbaProject.bin')) {
    return { detectedType: 'macro-office', hasMacros: true };
  }

  if (ascii.includes('word/')) {
    return { detectedType: 'docx' };
  }

  if (ascii.includes('ppt/')) {
    return { detectedType: 'pptx' };
  }

  return { detectedType: 'openxml' };
}

function detectFileType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }

  if (buffer.slice(0, 5).toString('ascii') === '%PDF-') {
    return { detectedType: 'pdf' };
  }

  if (hasHeader(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { detectedType: 'png' };
  }

  if (hasHeader(buffer, [0xff, 0xd8, 0xff])) {
    return { detectedType: 'jpeg' };
  }

  const gifHeader = buffer.slice(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return { detectedType: 'gif' };
  }

  if (
    buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
    buffer.slice(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { detectedType: 'webp' };
  }

  if (buffer.length >= 12 && buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii');
    return { detectedType: brand === 'qt  ' ? 'mov' : 'mp4' };
  }

  if (hasHeader(buffer, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { detectedType: 'webm' };
  }

  if (hasHeader(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    return detectOpenXmlType(buffer);
  }

  if (hasHeader(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { detectedType: 'legacy-office' };
  }

  return null;
}

function normalizeAllowedExtensions(allowedExtensions = ALL_EXTENSIONS) {
  return allowedExtensions.map((extension) => extension.toLowerCase().replace(/^\./, ''));
}

function isCompatibleType(extension, detectedType) {
  if (extension === detectedType) return true;
  if ((extension === 'jpg' || extension === 'jpeg') && detectedType === 'jpeg') return true;
  return (extension === 'mp4' || extension === 'm4v') && detectedType === 'mp4';
}

function validateUploadedFile(file, options = {}) {
  if (!file) {
    throw createUploadError('No file provided');
  }

  if (!file.buffer || file.buffer.length === 0) {
    throw createUploadError('The uploaded file is empty.');
  }

  const allowedExtensions = normalizeAllowedExtensions(options.allowedExtensions);
  const originalName = sanitizeOriginalName(file.originalname);
  const extension = getExtension(originalName);

  if (!extension || !allowedExtensions.includes(extension)) {
    throw createUploadError(`Unsupported file type. Allowed types: ${allowedExtensions.join(', ')}.`);
  }

  const expectedType = getTypeByExtension(extension);
  const detection = detectFileType(file.buffer);

  if (!expectedType || !detection) {
    throw createUploadError('Unable to verify this file. Please upload a valid PDF, PPTX, DOCX, image, or video.');
  }

  if (detection.hasMacros || detection.detectedType === 'macro-office') {
    throw createUploadError('Office files with macros are not allowed. Please upload a macro-free DOCX or PPTX.');
  }

  if (detection.detectedType === 'legacy-office') {
    throw createUploadError('Legacy Office files are not allowed. Please upload DOCX or PPTX instead.');
  }

  if (!isCompatibleType(extension, detection.detectedType)) {
    throw createUploadError('The file extension does not match the file content.');
  }

  const uniquePrefix = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

  return {
    originalName,
    storageName: `${uniquePrefix}_${originalName}`,
    extension,
    contentType: expectedType.contentType,
    category: expectedType.category,
    size: file.size,
  };
}

function getUploadErrorResponse(error, maxSizeLabel) {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return {
        status: 400,
        body: { error: `File too large. Maximum size is ${maxSizeLabel}.` },
      };
    }

    return {
      status: 400,
      body: { error: `Upload error: ${error.message}` },
    };
  }

  return {
    status: error.statusCode || 500,
    body: { error: error.statusCode ? error.message : 'Internal server error during upload' },
  };
}

module.exports = {
  ALL_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  createMemoryUpload,
  getUploadErrorResponse,
  validateUploadedFile,
};
