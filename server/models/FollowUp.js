const mongoose = require("mongoose");

const followUpSchema = new mongoose.Schema(
  {
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Application",
      required: [true, "Application ID is required"],
    },
    subject: { type: String, required: [true, "Subject is required"] },
    body: { type: String, required: [true, "Body is required"] },
    scheduledDate: { type: Date },
    sent: { type: Boolean, default: false },
    draftedByAI: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("FollowUp", followUpSchema);
