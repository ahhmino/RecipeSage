var aws = require('aws-sdk');
var multer = require('multer');
var multerImager = require('multer-imager');
var multerS3 = require('multer-s3');
var request = require('request');
var Raven = require('raven');
let fs = require('fs-extra');
let sharp = require('sharp');
let path = require('path');
let zlib = require('zlib');

// Service
var FirebaseService = require('./firebase');
var GripService = require('./grip');
var config = require('../config/config.json');

var s3 = new aws.S3();
aws.config.update({
  accessKeyId: config.aws.accessKeyId,
  secretAccessKey: config.aws.secretAccessKey,
  subregion: config.aws.region,
  region: config.aws.region,
});

exports.sendmail = (toAddresses, ccAddresses, subject, html, plain) => {
  ccAddresses = ccAddresses || [];

  // Create sendEmail params
  var params = {
    Destination: { /* required */
      CcAddresses: ccAddresses,
      ToAddresses: toAddresses
    },
    Message: { /* required */
      Body: { /* required */
        Html: {
          Charset: "UTF-8",
          Data: html
        },
        Text: {
          Charset: "UTF-8",
          Data: plain
        }
      },
      Subject: {
        Charset: 'UTF-8',
        Data: subject
      }
    },
    Source: '"RecipeSage" <noreply@recipesage.com>', /* required */
    ReplyToAddresses: [
      'noreply@recipesage.com',
      /* more items */
    ],
  };

  // Create the promise and SES service object
  return new aws.SES({ apiVersion: '2010-12-01' }).sendEmail(params).promise();
}

exports.fetchImage = url => {
  return new Promise((resolve, reject) => {
    request.get({
      url: url,
      encoding: null
    }, (err, res, body) => {
      if (err) {
        reject(err);
      } else {
        resolve({ res, body });
      }
    });
  })
}

const S3_DEFAULT_ACL = 'public-read';
const S3_DEFAULT_CACHECONTROL = 'public,max-age=31536000,immutable'; // 365 Days

const HIGH_RES_IMG_CONVERSION_WIDTH = 1024;
const HIGH_RES_IMG_CONVERSION_HEIGHT = 1024;
const HIGH_RES_IMG_CONVERSION_QUALITY = 85;

const LOW_RES_IMG_CONVERSION_WIDTH = 200;
const LOW_RES_IMG_CONVERSION_HEIGHT = 200;
const LOW_RES_IMG_CONVERSION_QUALITY = 55;

exports.sendBufferToS3 = buffer => {
  let key = new Date().getTime().toString();
  let bucket = config.aws.bucket;

  return s3.putObject({
    Bucket: bucket,
    Key: key,
    ACL: S3_DEFAULT_ACL,
    CacheControl: S3_DEFAULT_CACHECONTROL,
    Body: buffer // buffer
  }).promise().then(s3Response => {
    return {
      s3Response,
      key,
      acl: S3_DEFAULT_ACL,
      bucket
    }
  })
}

exports.formatS3ImageResponse = (key, mimetype, size, etag) => {
  return {
    fieldname: "image",
    originalname: 'recipe-sage-img.jpg',
    mimetype,
    size,
    bucket: config.aws.bucket,
    key,
    acl: S3_DEFAULT_ACL,
    metadata: {
      fieldName: "image"
    },
    location: 'https://' + config.aws.bucket + '.s3.' + config.aws.region + '.amazonaws.com/' + key,
    etag
  }
}

exports.convertImage = (imageBuf, highResConversion) => {
  const height = highResConversion ? HIGH_RES_IMG_CONVERSION_HEIGHT : LOW_RES_IMG_CONVERSION_HEIGHT;
  const width = highResConversion ? HIGH_RES_IMG_CONVERSION_WIDTH : LOW_RES_IMG_CONVERSION_WIDTH;
  const quality = highResConversion ? HIGH_RES_IMG_CONVERSION_QUALITY : LOW_RES_IMG_CONVERSION_QUALITY;

  return new Promise((resolve, reject) => {
    try {
      sharp(imageBuf)
        .rotate() // Rotates based on EXIF data
        .resize(width, height) // Uses object-fit: cover by default
        .jpeg({
          quality,
          // chromaSubsampling: '4:4:4'
        })
        .toBuffer((err, buffer, info) => {
          if (err) reject(err);
          resolve(buffer);
        });
    } catch (e) {
      reject();
    }
  })
}

exports.sendURLToS3 = (url, highResConversion)  => {
  return exports.fetchImage(url).then(({ res, body }) => {
    return exports.convertImage(body, highResConversion).then(convertedBuffer => {
      return exports.sendBufferToS3(convertedBuffer).then(result => {
        return exports.formatS3ImageResponse(result.key, "image/jpeg", Buffer.byteLength(convertedBuffer), result.s3Response.ETag);
      });
    });
  })
}

exports.sendFileToS3 = (file, isBuffer, highResConversion) => {
  let p = isBuffer ? Promise.resolve(file) : fs.readFile(file);

  return p.then(buf => {
    return exports.convertImage(buf, highResConversion);
  }).then(stream => {
    return exports.sendBufferToS3(stream);
  }).then(result => {
    var stats = isBuffer ? { size: file.length } : fs.statSync(file);
    return exports.formatS3ImageResponse(result.key, 'image/jpeg', stats["size"], result.s3Response.ETag)
  })
}

exports.upload = async (fieldName, req, res, highResConversion) => {
  const height = highResConversion ? HIGH_RES_IMG_CONVERSION_HEIGHT : LOW_RES_IMG_CONVERSION_HEIGHT;
  const width = highResConversion ? HIGH_RES_IMG_CONVERSION_WIDTH : LOW_RES_IMG_CONVERSION_WIDTH;
  const quality = highResConversion ? HIGH_RES_IMG_CONVERSION_QUALITY : LOW_RES_IMG_CONVERSION_QUALITY;

  await new Promise((resolve, reject) => {
    multer({
      storage: multerImager({
        dirname: '/',
        bucket: config.aws.bucket,
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
        region: config.aws.region,
        filename: (req, file, cb) => {  // [Optional]: define filename (default: random)
          cb(null, Date.now())                // i.e. with a timestamp
        },                                    //
        gm: {                                 // [Optional]: define graphicsmagick options
          width,                         // doc: http://aheckmann.github.io/gm/docs.html#resize
          // height: 200,
          options: '',
          format: 'jpg',                      // Default: jpg - Unused by our processor
          process: (gm, options, inputStream, outputStream) => {
            let pipeline = sharp()
            pipeline.rotate() // Rotates based on EXIF data
              .resize(width, height) // Uses object-fit: cover by default
              .jpeg({
                quality,
                // chromaSubsampling: '4:4:4' // Enable this option to prevent color loss at low quality - increases image size
              })
              .pipe(outputStream);

            inputStream.pipe(pipeline);
          }
        },
        s3 : {                                // [Optional]: define s3 options
          ACL: S3_DEFAULT_ACL,
          CacheControl: S3_DEFAULT_CACHECONTROL,
          Metadata: {
            'acl': S3_DEFAULT_ACL,
            'cache-control': S3_DEFAULT_CACHECONTROL
          }
        }
      }),
      limits: {
        fileSize: 8 * 1024 * 1024 // 8MB
      }
    }).single(fieldName)(req, res, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  })
};

exports.deleteS3Object = key => {
  return new Promise((resolve, reject) => {
    s3.deleteObject({
      Bucket: config.aws.bucket,
      Key: key
    }, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

exports.dispatchImportNotification = (user, status, reason) => {
  var event;
  if (status === 0) {
    event = 'complete';
  } else if (status === 1) {
    event = 'failed';
  } else if (status === 2) {
    event = 'working';
  } else {
    return;
  }

  let type = "import:pepperplate:" + event

  var message = {
    type,
    reason: reason || 'status'
  }

  let sendQueues = []
  if (user.fcmTokens) {
    sendQueues.push(FirebaseService.sendMessages(user.fcmTokens.map(fcmToken => fcmToken.token), message));
  }

  sendQueues.push(GripService.broadcast(user.id, type, message));

  return Promise.all(sendQueues);
}

exports.sortRecipeImages = recipe => {
  if (recipe.toJSON) recipe = recipe.toJSON();

  if (recipe.images && recipe.images.length > 0) {
    recipe.images.sort((a, b) => a.Recipe_Image.order - b.Recipe_Image.order);
  }

  return recipe;
}

exports.dispatchMessageNotification = (user, fullMessage) => {
  var message = {
    id: fullMessage.id,
    body: fullMessage.body.substring(0, 1000), // Keep payload size reasonable if there's a long message. Max total payload size is 2048
    otherUser: fullMessage.otherUser,
    fromUser: fullMessage.fromUser,
    toUser: fullMessage.toUser
  };

  if (fullMessage.recipe) {
    message.recipe = {
      id: fullMessage.recipe.id,
      title: fullMessage.recipe.title,
      images: fullMessage.recipe.images.map(image => ({
        location: image.location
      }))
    };
  }

  let sendQueues = [];
  if (user.fcmTokens) {
    var notification = {
      type: "messages:new",
      message: JSON.stringify(message)
    };

    sendQueues.push(FirebaseService.sendMessages(user.fcmTokens.map(fcmToken => fcmToken.token), notification));
  }

  sendQueues.push(GripService.broadcast(user.id, 'messages:new', message));

  return Promise.all(sendQueues);
}

exports.findFilesByRegex = (searchPath, regex) => {
  if (!fs.existsSync(searchPath)) {
    return [];
  }

  return fs.readdirSync(searchPath).reduce((acc, subPath) => {
    let newPath = path.join(searchPath, subPath);

    if (newPath.match(regex)) {
      return [newPath, ...acc]
    }

    if (fs.lstatSync(newPath).isDirectory()) return [...acc, ...exports.findFilesByRegex(newPath, regex)]

    return acc
  }, [])
};

exports.sanitizeEmail = email => (email || '').trim().toLowerCase();

// Very liberal email regex. Don't want to reject valid user emails.
let emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
exports.validateEmail = email => emailRegex.test(email);

exports.validatePassword = password => typeof password === 'string' && password.length >= 6;

exports.gunzip = buf => {
  return new Promise((resolve, reject) => {
    zlib.gunzip(buf, (err, result) => {
      if (err) reject(err);
      resolve(result);
    })
  })
}

// CBs are an array of promises to be executed by chunkSize
// Waits until previous is done before executing next chunk
exports.executeInChunks = async (cbs, chunkSize) => {
  if (chunkSize < 1) return Promise.resolve();

  let chunks = [];
  for (let i = 0; i < cbs.length; i += chunkSize) {
    chunks.push(cbs.slice(i, i + chunkSize));
  }

  await chunks.reduce((acc, chunk) => {
    return acc.then(() => {
      return Promise.all(chunk.map(cb => cb()))
    })
  }, Promise.resolve())
}
