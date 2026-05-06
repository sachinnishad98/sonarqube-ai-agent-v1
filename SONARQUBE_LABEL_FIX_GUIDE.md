# SonarQube Label Fix Guide
## Change "Reliability" to "Bugs" and "Maintainability" to "Code Smells"

---

## 🎯 Problem
SonarQube v26.4 uses:
- **Reliability** (you want: **Bugs**)
- **Maintainability** (you want: **Code Smells**)

The SonarQube dashboard UI is hardcoded and cannot be changed directly.

---

## ✅ Solution: Browser Extension (Tampermonkey)

### Step 1: Install Tampermonkey
1. Open Chrome/Edge browser
2. Install Tampermonkey extension:
   - Chrome: https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo
   - Edge: https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd

### Step 2: Add Custom Script
1. Click Tampermonkey icon in browser toolbar
2. Click **"Create a new script..."**
3. Delete all existing code
4. Copy the entire contents of `sonarqube-label-fix.js` file
5. Paste into the Tampermonkey editor
6. Press **Ctrl+S** to save
7. Close the tab

### Step 3: Verify
1. Open http://localhost:9000
2. Open any project
3. You should now see:
   - ✅ **Bugs** (instead of Reliability)
   - ✅ **Code Smells** (instead of Maintainability)
   - ✅ **Hotspots** (instead of Security Hotspots)

### Step 4: Open Developer Console (Optional)
- Press **F12** → Console tab
- You should see: `[SonarQube Label Fix] Extension loaded - Reliability→Bugs, Maintainability→Code Smells`

---

## 🔧 Alternative: Chrome DevTools Console (Temporary)

If you don't want to install Tampermonkey, you can run this in Chrome DevTools Console (F12):

```javascript
// Run this in Console on http://localhost:9000
setInterval(() => {
  document.body.innerHTML = document.body.innerHTML
    .replace(/\bReliability\b/g, 'Bugs')
    .replace(/\bMaintainability\b/g, 'Code Smells');
}, 500);
```

**Note:** This is temporary and will reset on page refresh.

---

## 📊 Custom Dashboard (Already Done)

Your custom dashboard at **http://localhost:3002** already shows:
- ✅ Bugs (not Reliability)
- ✅ Code Smells (not Maintainability)
- ✅ Organization-style horizontal metrics bar

This dashboard is fully under your control and doesn't need browser extensions.

---

## ⚠️ Important Notes

1. **SonarQube UI cannot be modified directly** - it's compiled Java/React code
2. **Browser extension is client-side only** - it changes what YOU see, not what others see
3. **For production/team use:** Everyone needs to install the Tampermonkey script
4. **Best approach:** Use your custom dashboard (localhost:3002) for presentations

---

## 🎥 Demo Screenshot

After applying the fix, your SonarQube dashboard will show:

```
Security    Bugs    Code Smells    Hotspots    Coverage    Duplications
   0         22         78           0.0%        0.0%         0.0%
   A         C          A            E           —            •
```

Instead of:

```
Security    Reliability    Maintainability    Hotspots    Coverage    Duplications
   0            22              78             0.0%        0.0%         0.0%
   A            C               A              E           —            •
```

---

## 📞 Need Help?

If Tampermonkey script doesn't work:
1. Check browser console (F12) for errors
2. Verify Tampermonkey is enabled (green icon)
3. Try refreshing the SonarQube page (Ctrl+F5)
4. Make sure the script is enabled in Tampermonkey dashboard
