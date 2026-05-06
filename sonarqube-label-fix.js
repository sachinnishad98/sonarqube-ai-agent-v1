// ==UserScript==
// @name         SonarQube Label Fix - Change Reliability/Maintainability to Bugs/Code Smells
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Changes SonarQube v26+ labels from "Reliability" to "Bugs" and "Maintainability" to "Code Smells"
// @author       SachinNishad
// @match        http://localhost:9000/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Function to replace text in the page
    function replaceLabels() {
        // Find all text nodes in the document
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null,
            false
        );

        const nodesToReplace = [];
        let node;

        while (node = walker.nextNode()) {
            if (node.nodeValue.includes('Reliability') ||
                node.nodeValue.includes('Maintainability') ||
                node.nodeValue.includes('Security Hotspots')) {
                nodesToReplace.push(node);
            }
        }

        nodesToReplace.forEach(node => {
            let newValue = node.nodeValue;
            newValue = newValue.replace(/\bReliability\b/g, 'Bugs');
            newValue = newValue.replace(/\bMaintainability\b/g, 'Code Smells');
            newValue = newValue.replace(/\bSecurity Hotspots\b/g, 'Hotspots');
            node.nodeValue = newValue;
        });

        // Also check for React-rendered content
        document.querySelectorAll('[data-testid*="reliability"], [aria-label*="Reliability"]').forEach(el => {
            if (el.textContent.includes('Reliability')) {
                el.textContent = el.textContent.replace(/\bReliability\b/g, 'Bugs');
            }
        });

        document.querySelectorAll('[data-testid*="maintainability"], [aria-label*="Maintainability"]').forEach(el => {
            if (el.textContent.includes('Maintainability')) {
                el.textContent = el.textContent.replace(/\bMaintainability\b/g, 'Code Smells');
            }
        });
    }

    // Run on page load
    window.addEventListener('load', replaceLabels);

    // Run periodically to catch dynamically loaded content (React apps)
    setInterval(replaceLabels, 1000);

    // Also observe DOM changes
    const observer = new MutationObserver(replaceLabels);
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    console.log('[SonarQube Label Fix] Extension loaded - Reliability→Bugs, Maintainability→Code Smells');
})();
