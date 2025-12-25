const tabsContainer = document.getElementById('tabs-container');

const platform = window.shellAPI.getPlatform();
document.body.classList.add(`platform-${platform}`);

document.getElementById('btn-reload').onclick = () => {
    console.log('Reload clicked');
    window.shellAPI.reloadActiveView();
};

document.getElementById('btn-stop').onclick = () => {
    console.log('Stop clicked');
    window.shellAPI.stopActiveView();
};

document.getElementById('btn-open').onclick = () => {
    console.log('Open clicked');
    window.shellAPI.openFileDialog();
};

window.shellAPI.onUpdateTabs((tabs) => {
    renderTabs(tabs);
});

window.shellAPI.onThemeChange((theme) => {
    if (theme === 'dark') {
        document.body.classList.remove('light-theme');
    } else {
        document.body.classList.add('light-theme');
    }
});

function renderTabs(tabs) {
    tabsContainer.innerHTML = '';

    // Create a local list to manipulate during drag (though we rely on main process for final state)
    // We render based on the 'tabs' array passed from main, which should be in correct order.

    tabs.forEach(tab => {
        const tabEl = document.createElement('div');
        tabEl.className = `tab ${tab.active ? 'active' : ''}`;
        tabEl.onclick = () => window.shellAPI.selectTab(tab.id);
        tabEl.title = tab.fullPath || tab.title;
        tabEl.draggable = true;

        tabEl.ondragstart = (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', tab.id.toString());
            tabEl.classList.add('dragging');
        };

        tabEl.ondragend = (e) => {
            tabEl.classList.remove('dragging');
        };

        tabEl.ondragover = (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
        };

        tabEl.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation();

            const sourceId = parseInt(e.dataTransfer.getData('text/plain'));
            if (isNaN(sourceId) || sourceId === tab.id) return;

            // Calculate new order
            // We need to know the current indices. 'tabs' array has the current order.
            const sourceIndex = tabs.findIndex(t => t.id === sourceId);
            const targetIndex = tabs.findIndex(t => t.id === tab.id);

            if (sourceIndex === -1 || targetIndex === -1) return;

            const newOrder = [...tabs];
            const [movedTab] = newOrder.splice(sourceIndex, 1);
            newOrder.splice(targetIndex, 0, movedTab);

            const newOrderIds = newOrder.map(t => t.id);
            window.shellAPI.reorderTabs(newOrderIds);
        };

        const titleEl = document.createElement('span');
        titleEl.className = 'tab-title';
        titleEl.textContent = tab.title;
        tabEl.appendChild(titleEl);

        const closeEl = document.createElement('div');
        closeEl.className = 'tab-close';
        closeEl.onclick = (e) => {
            e.stopPropagation();
            window.shellAPI.closeTab(tab.id);
        };
        tabEl.appendChild(closeEl);

        tabsContainer.appendChild(tabEl);
    });
}


// Drag and Drop
document.body.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
});

document.body.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();

    for (const f of e.dataTransfer.files) {
        window.shellAPI.openFile(f.path);
    }
});
