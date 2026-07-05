const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');

let gridFSBucket = null;

/**
 * Get or create GridFS bucket instance
 */
async function getGridFSBucket() {
  if (gridFSBucket) {
    return gridFSBucket;
  }

  const db = mongoose.connection.db;
  
  if (!db) {
    throw new Error('Database connection not established');
  }

  gridFSBucket = new GridFSBucket(db, { bucketName: 'uploads' });
  return gridFSBucket;
}

/**
 * Upload a file to GridFS
 * @param buffer File buffer
 * @param filename Original filename
 * @param metadata Optional metadata to store with the file
 * @returns GridFS file ID
 */
async function uploadFileToGridFS(buffer, filename, metadata) {
  const bucket = await getGridFSBucket();
  
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, {
      metadata: metadata || {},
    });

    uploadStream.on('error', (error) => {
      reject(error);
    });

    uploadStream.on('finish', () => {
      resolve(uploadStream.id.toString());
    });

    uploadStream.end(buffer);
  });
}

/**
 * Download a file from GridFS by ID
 * @param fileId GridFS file ID
 */
async function downloadFileFromGridFS(fileId) {
  const bucket = await getGridFSBucket();
  const ObjectId = mongoose.Types.ObjectId;

  if (!ObjectId.isValid(fileId)) {
    throw new Error('Invalid file ID');
  }

  const fileIdObj = new ObjectId(fileId);

  const files = await bucket.find({ _id: fileIdObj }).toArray();
  if (files.length === 0) {
    throw new Error('File not found');
  }

  const fileInfo = files[0];

  return new Promise((resolve, reject) => {
    const downloadStream = bucket.openDownloadStream(fileIdObj);
    const chunks = [];

    downloadStream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    downloadStream.on('error', (error) => {
      reject(error);
    });

    downloadStream.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const filename = fileInfo.filename || 'file';
      const contentType = fileInfo.metadata?.contentType;
      const metadata = fileInfo.metadata;

      resolve({
        buffer,
        filename,
        contentType,
        metadata,
      });
    });
  });
}

/**
 * Delete a file from GridFS
 * @param fileId GridFS file ID
 */
async function deleteFileFromGridFS(fileId) {
  const bucket = await getGridFSBucket();
  const ObjectId = mongoose.Types.ObjectId;

  if (!ObjectId.isValid(fileId)) {
    throw new Error('Invalid file ID');
  }

  const fileIdObj = new ObjectId(fileId);
  await bucket.delete(fileIdObj);
}

module.exports = {
  uploadFileToGridFS,
  downloadFileFromGridFS,
  deleteFileFromGridFS,
};
