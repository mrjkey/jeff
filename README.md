# jeff

A small web page for controlling an Ecovacs Deebot robot: start, pause, stop,
return to dock, suction and water level, battery, consumables, and an
interactive map (clean selected rooms or send the robot to a point).

A Go server serves the page and runs a Node bridge (`bridge/`) that talks to the
robot through the [ecovacs-deebot](https://github.com/mrbungle64/ecovacs-deebot.js) library.

## Run

```bash
cp .env.example .env   # then fill it in
docker compose up -d --build
```

Open <http://localhost:3000>.

If Ecovacs asks to verify this app, it e-mails a code to the account address
and the page shows a form to enter it. Verification is tied to
`ECOVACS_CLIENT_DEVICE_ID`, so keep that value when moving the container.

## Editing the map

Switch the map to **Edit map** to add or delete virtual boundaries (normal or
no-mop, as a box or a line), merge or divide rooms, label rooms, or delete the
map. The library has no commands for most of these, so `bridge/maps.js` sends
the same requests the Ecovacs app sends to T8/T9 series robots.

## Map backups

**Save current map** writes the rooms, labels and boundaries of the current map
to `data/map-backups/` (not in git). Each backup also records the id of the
backup the robot keeps of that map itself. Then you can:

- **Re-apply labels and boundaries** to copy the labels and boundaries onto the
  current map. This is refused when the current map doesn't overlap the saved
  one, because then the robot probably mapped from somewhere else.
- **Restore robot backup** to ask the robot to restore the whole map from its
  own backup. This only works while the robot still has that backup.

The robot can't receive a map file. It only accepts a map it built itself.
