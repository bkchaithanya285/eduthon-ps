# Eduthon 🚀

**Eduthon** is a hackathon problem statement selection system, branded for the "Eduthon" event conducted by the **IEEE Education Society**.

## Features
- **Team Registration**: Teams can register and select a unique problem statement.
- **Real-time Updates**: Live dashboard updates for problem availability.
- **Admin Panel**: Manage registrations, export data (PDF/CSV), and reset database.
- **Orange Aesthetic**: Modern, dark-themed UI with vibrant orange accents.

## Prerequisities
- Node.js (v18 or higher)

## How to Run

1.  **Install Dependencies** (First time only):
    ```bash
    npm install
    ```

2.  **Start the Server**:
    ```bash
    npm start
    ```
    Or for development:
    ```bash
    node app.js
    ```

3.  **Access the App**:
    - **Home**: [http://localhost:3000](http://localhost:3000)
    - **Admin**: [http://localhost:3000/admin-login](http://localhost:3000/admin-login)

## Environment Variables
Create a `.env` file (optional for local dev, uses defaults if missing):
```env
PORT=3000
ADMIN_USER=admin
ADMIN_PASS=password
# MONGODB_URI=mongodb://... (Optional: defaults to local JSON file)
```
