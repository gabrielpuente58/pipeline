const mongoose = require("mongoose");

const gmailTokenSchema = new mongoose.Schema(
  {
    access_token: { type: String, required: true },
    refresh_token: { type: String, required: true },
    expiry_date: { type: Number },
  },
  { timestamps: true }
);

module.exports = mongoose.model("GmailToken", gmailTokenSchema);
