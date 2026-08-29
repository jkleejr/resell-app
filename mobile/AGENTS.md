# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.
Match the SDK this app is actually pinned to — not the latest docs Expo serves by default.

## Do not bump the Expo SDK

This app is pinned to **Expo SDK 54** (`expo@54`, React Native 0.81) on purpose.
The App Store build of Expo Go on the developer's iPhone runs SDK 54, and Expo Go
supports exactly one SDK version. `create-expo-app` defaulted to SDK 56; both 56
and 55 showed "incompatible with this version of Expo Go" on the device. Only 54
loads, which is what makes on-device testing possible at all.

Changing the SDK is a deliberate decision that needs the developer's sign-off —
it means either confirming their Expo Go supports the new version, or moving to a
development build. To do it: `npx expo install expo@<sdk> --fix`.
