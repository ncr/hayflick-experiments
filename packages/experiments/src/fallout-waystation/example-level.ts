import { defineLevel } from "./authoring";

export const exampleWaystationLevel = defineLevel(
  {
    id: "fallout-waystation.example",
    title: "Roadside Cutaway Waystation"
  },
  (level) => {
    level.place("ground", "waystation.ground");
    level.place("building", "waystation.building");
    level.place("props", "waystation.props");
    level.place("light-shafts", "waystation.light-shafts", {
      building: "building"
    });
    level.place("dust", "waystation.dust");
    level.place("smoke", "waystation.smoke");
    level.place("steam", "waystation.steam");
  }
);
