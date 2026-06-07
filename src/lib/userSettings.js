const mongoose = require('mongoose');

const userSettingSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    ign: { type: String, required: true },
    ltcAddress: { type: String, required: true },
  },
  { timestamps: true }
);

const UserSetting = mongoose.model('UserSetting', userSettingSchema);

async function getUserSettings(userId) {
  try {
    return await UserSetting.findOne({ userId });
  } catch (err) {
    console.error(`Failed to fetch settings for ${userId}:`, err.message);
    return null;
  }
}

async function setUserSettings(userId, ign, ltcAddress) {
  try {
    return await UserSetting.findOneAndUpdate(
      { userId },
      { ign, ltcAddress },
      { upsert: true, returnDocument: 'after' }
    );
  } catch (err) {
    console.error(`Failed to save settings for ${userId}:`, err.message);
    throw err;
  }
}

module.exports = { UserSetting, getUserSettings, setUserSettings };
