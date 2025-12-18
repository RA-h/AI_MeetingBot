# Inclusive AI Meeting Bot

AI Meeting Bot built using Recall.ai Meeting Bot API + OpenAI Responses API+ React + Vite for the frontend.

## Features

 - Feature 1
 - Feature 2
 - Feature 3
 - Feature 4

## How To Run

## Before you start
You will need to install cloudflare. Do this from your default system terminal path.
    - Windows: `winget install Cloudflare.cloudflared`
    - macOS: `brew install cloudflared`

1. Set keys in .env (your actual API Keys)
    - an example format is shown in .env.example 
    - Public URL Base will be empty for now... If you have one of your own though, set it here.

2. Open 3 terminals (RUN IN EXACT ORDER): 
   - `cd backend` --> `npm install` (once) --> `npm run tunnel` 
      (You will recieve a public URL that you will paste into the .env file.)
      (Run this only if you did not set your own Public URL)
   - `cd backend` --> `npm start` 
   - `cd frontend` --> `npm install` (once) --> `npm run dev`

3. Start a Zoom meeting. 


4. Open the Cloudflare Link provided by the frontend terminal (vite)
    - Paste Zoom link into provided textbox.

5. Closing the application
   - Windows: Don't forget to `Ctrl` + `C` both terminals to close backend and frontend when you are finished with the application. 
   - MacOS: Don't forget to `Ctrl` + `C` OR `Command` + `.` both terminals to close backend and frontend when you are finished with the application.
   
 
