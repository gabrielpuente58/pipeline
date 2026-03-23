const mongoose = require("mongoose");

const athleteSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    gender: {
      type: String,
      required: [true, "Gender is required"],
      enum: {
        values: ["male", "female", "prefer-not-to-say"],
        message: "Gender must be male, female, or prefer-not-to-say",
      },
    },
    height: {
      type: Number,
      required: [true, "Height is required"],
      min: [36, "Height must be at least 36 inches"],
      max: [108, "Height must be at most 108 inches"],
    },
    weight: {
      type: Number,
      required: [true, "Weight is required"],
      min: [50, "Weight must be at least 50 lbs"],
      max: [500, "Weight must be at most 500 lbs"],
    },
    profilePicture: {
      type: String,
      default: "",
    },
    raceDate: {
      type: Date,
      required: [true, "Race date is required"],
    },
    raceLocation: {
      type: String,
      required: [true, "Race location is required"],
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Athlete", athleteSchema);
