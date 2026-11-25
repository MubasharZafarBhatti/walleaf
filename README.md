# Walleaf

A simple personal finance app for Android. Everything stays on your phone: no account, no internet, no ads.

## Features

- Expenses and income, with categories, search and filters
- Accounts (cash, bank, e-wallet) and moving money between them
- A monthly spending plan that warns you before you overspend
- Savings goals
- People: money you lent or borrowed, and who owes whom
- Split bills, including group trips
- Subscriptions and planned payments, with reminders on the due date
- Charts of where your money goes
- Backup and restore to a file

## Built with

Expo SDK 57, React Native 0.86, TypeScript, Expo SQLite, React Navigation and Jest.

## Run it

```sh
npm install
npx expo start
```

Reminders need a real build rather than Expo Go:

```sh
npx expo run:android
```

## Checks

```sh
npm run typecheck
npm run lint
npm test
```

## Download

The latest APK is on the [Releases](../../releases) page.
