const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const fs = require("fs");

// File type mappings for security
const ALLOWED_FILE_TYPES = {
  image: {
    mimeTypes: [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
    ],
    extensions: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
    maxSize: parseInt(process.env.MAX_IMAGE_SIZE_BYTES) || 2 * 1024 * 1024, // 2MB
  },
  document: {
    mimeTypes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ],
    extensions: [".pdf", ".doc", ".docx", ".txt"],
    maxSize: parseInt(process.env.MAX_DOCUMENT_SIZE_BYTES) || 5 * 1024 * 1024, // 5MB
  },
  general: {
    mimeTypes: [], // Will be populated with all allowed types
    extensions: [], // Will be populated with all allowed extensions
    maxSize: parseInt(process.env.MAX_FILE_SIZE_BYTES) || 1 * 1024 * 1024, // 1MB default
  },
};

// Populate general type with all allowed types
ALLOWED_FILE_TYPES.general.mimeTypes = [
  ...ALLOWED_FILE_TYPES.image.mimeTypes,
  ...ALLOWED_FILE_TYPES.document.mimeTypes,
];
ALLOWED_FILE_TYPES.general.extensions = [
  ...ALLOWED_FILE_TYPES.image.extensions,
  ...ALLOWED_FILE_TYPES.document.extensions,
];

/**
 * File signature validation to prevent MIME type spoofing
 * @param {Buffer} buffer - File buffer
 * @param {string} mimeType - Claimed MIME type
 * @returns {boolean} True if file signature matches MIME type
 */
const validateFileSignature = (buffer, mimeType) => {
  if (!buffer || buffer.length < 4) return false;

  const signatures = {
    "image/jpeg": [
      [0xFF, 0xD8, 0xFF], // JPEG
    ],
    "image/jpg": [
      [0xFF, 0xD8, 0xFF], // JPEG
    ],
    "image/png": [
      [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], // PNG
    ],
    "image/gif": [
      [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
      [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
    ],
    "image/webp": [
      [0x52, 0x49, 0x46, 0x46], // RIFF (check further for WEBP)
    ],
    "application/pdf": [
      [0x25, 0x50, 0x44, 0x46], // %PDF
    ],
    "text/plain": [
      // Text files don't have reliable magic numbers, allow everything for now
      [],
    ],
  };

  const fileSignatures = signatures[mimeType];
  if (!fileSignatures || fileSignatures.length === 0) {
    return mimeType === "text/plain"; // Allow text files
  }

  return fileSignatures.some(signature => {
    return signature.every((byte, index) => buffer[index] === byte);
  });
};

/**
 * Virus scanning placeholder (integrate with ClamAV or similar)
 * @param {Buffer} buffer - File buffer
 * @returns {Promise<boolean>} Promise resolving to true if file is clean
 */
const scanForVirus = async (buffer) => {
  // TODO: Integrate with actual antivirus scanner
  // For now, just check for common malicious patterns
  const maliciousPatterns = [
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    /javascript:/gi,
    /vbscript:/gi,
    /onload\s*=/gi,
    /onerror\s*=/gi,
  ];

  const content = buffer.toString('utf8').substring(0, 1024); // Check first 1KB
  return !maliciousPatterns.some(pattern => pattern.test(content));
};

/**
 * Create upload middleware for specific file type
 * @param {string} fileType - File type ('image', 'document', 'general')
 * @param {Object} options - Additional options
 * @returns {Function} Multer middleware
 */
const createUploadMiddleware = (fileType = "general", options = {}) => {
  const config = ALLOWED_FILE_TYPES[fileType] || ALLOWED_FILE_TYPES.general;
  const maxFileSize = config.maxSize;

  // Memory storage for security validation
  const storage = multer.memoryStorage();

  const multerInstance = multer({
    storage,
    limits: {
      fileSize: maxFileSize,
      files: options.maxFiles || 1,
      fields: options.maxFields || 10,
      fieldNameSize: 100,
      fieldSize: 1024,
    },
    fileFilter: (req, file, cb) => {
      try {
        // Check MIME type
        if (!config.mimeTypes.includes(file.mimetype)) {
          return cb(new Error(`Invalid file type. Allowed: ${config.mimeTypes.join(", ")}`), false);
        }

        // Check file extension
        const fileExtension = path.extname(file.originalname).toLowerCase();
        if (!config.extensions.includes(fileExtension)) {
          return cb(new Error(`Invalid file extension. Allowed: ${config.extensions.join(", ")}`), false);
        }

        // Check filename for malicious patterns
        if (/[<>:"/\\|?*]/.test(file.originalname)) {
          return cb(new Error("Invalid characters in filename"), false);
        }

        cb(null, true);
      } catch (error) {
        cb(error, false);
      }
    },
  });

  // Return middleware with additional validation
  return (req, res, next) => {
    multerInstance.single(options.fieldName || "file")(req, res, async (error) => {
      if (error) {
        if (error instanceof multer.MulterError) {
          switch (error.code) {
            case "LIMIT_FILE_SIZE":
              return res.status(413).json({
                message: `File too large. Maximum size: ${Math.round(maxFileSize / 1024)}KB`,
              });
            case "LIMIT_UNEXPECTED_FILE":
              return res.status(400).json({
                message: "Unexpected field name for file upload",
              });
            default:
              return res.status(400).json({
                message: `Upload error: ${error.message}`,
              });
          }
        }
        return res.status(400).json({
          message: error.message || "File upload failed",
        });
      }

      // Additional validation if file exists
      if (req.file) {
        try {
          // Validate file signature
          if (!validateFileSignature(req.file.buffer, req.file.mimetype)) {
            return res.status(400).json({
              message: "File signature does not match file type. Potential security risk.",
            });
          }

          // Scan for viruses (basic check)
          const isClean = await scanForVirus(req.file.buffer);
          if (!isClean) {
            return res.status(400).json({
              message: "File contains potentially malicious content",
            });
          }

          // Generate secure filename
          const fileExtension = path.extname(req.file.originalname);
          const secureFilename = crypto.randomUUID() + fileExtension;
          req.file.secureFilename = secureFilename;

          // Add additional metadata
          req.file.uploadedAt = new Date();
          req.file.validatedSize = req.file.buffer.length;

          console.log(`File uploaded: ${req.file.originalname} -> ${secureFilename}, Size: ${req.file.buffer.length} bytes`);
        } catch (validationError) {
          console.error("File validation error:", validationError);
          return res.status(500).json({
            message: "File validation failed",
          });
        }
      }

      next();
    });
  };
};

/**
 * Middleware for image uploads with specific validation
 * @param {Object} options - Upload options
 * @returns {Function} Express middleware
 */
const imageUpload = (options = {}) => {
  return createUploadMiddleware("image", {
    fieldName: "image",
    ...options,
  });
};

/**
 * Middleware for document uploads with specific validation
 * @param {Object} options - Upload options
 * @returns {Function} Express middleware
 */
const documentUpload = (options = {}) => {
  return createUploadMiddleware("document", {
    fieldName: "document",
    ...options,
  });
};

/**
 * General file upload middleware with strict validation
 * @param {Object} options - Upload options
 * @returns {Function} Express middleware
 */
const generalFileUpload = (options = {}) => {
  return createUploadMiddleware("general", {
    fieldName: "file",
    ...options,
  });
};

/**
 * Middleware for multiple files upload
 * @param {string} fileType - File type constraint
 * @param {Object} options - Upload options
 * @returns {Function} Express middleware
 */
const multipleFileUpload = (fileType = "general", options = {}) => {
  const config = ALLOWED_FILE_TYPES[fileType] || ALLOWED_FILE_TYPES.general;
  const storage = multer.memoryStorage();

  const multerInstance = multer({
    storage,
    limits: {
      fileSize: config.maxSize,
      files: options.maxFiles || 5,
      fields: options.maxFields || 10,
    },
    fileFilter: (req, file, cb) => {
      // Same validation as single file upload
      if (!config.mimeTypes.includes(file.mimetype)) {
        return cb(new Error(`Invalid file type. Allowed: ${config.mimeTypes.join(", ")}`), false);
      }

      const fileExtension = path.extname(file.originalname).toLowerCase();
      if (!config.extensions.includes(fileExtension)) {
        return cb(new Error(`Invalid file extension. Allowed: ${config.extensions.join(", ")}`), false);
      }

      if (/[<>:"/\\|?*]/.test(file.originalname)) {
        return cb(new Error("Invalid characters in filename"), false);
      }

      cb(null, true);
    },
  });

  return multerInstance.array(options.fieldName || "files", options.maxFiles || 5);
};

/**
 * Get upload configuration for client
 * @param {string} fileType - File type
 * @returns {Object} Configuration object
 */
const getUploadConfig = (fileType = "general") => {
  const config = ALLOWED_FILE_TYPES[fileType] || ALLOWED_FILE_TYPES.general;
  return {
    maxFileSize: config.maxSize,
    allowedMimeTypes: config.mimeTypes,
    allowedExtensions: config.extensions,
    maxFileSizeMB: Math.round(config.maxSize / (1024 * 1024) * 100) / 100,
  };
};

module.exports = {
  imageUpload,
  documentUpload,
  generalFileUpload,
  multipleFileUpload,
  createUploadMiddleware,
  getUploadConfig,
  validateFileSignature,
  ALLOWED_FILE_TYPES,
};