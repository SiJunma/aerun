const { onDocumentDeleted } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

// Ensure only a reasonable amount of instances run at once to manage billing safely
setGlobalOptions({ maxInstances: 10 });

exports.onUserDeleted = onDocumentDeleted("users/{userId}", async (event) => {
    const deletedUid = event.params.userId;
    try {
        await admin.auth().deleteUser(deletedUid);
        logger.info(`Successfully deleted auth user: ${deletedUid}`);
    } catch (error) {
        logger.error(`Error deleting auth user ${deletedUid}:`, error);
    }
});