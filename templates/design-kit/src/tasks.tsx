/**
 * The Preact trial page: a task list built from the same kit components as
 * the plain page, rendered by Preact. Nothing here names a theme.
 */
import { render } from 'preact';
import { useState } from 'preact/hooks';

interface Task {
  id: string;
  title: string;
  owner: string;
  done: boolean;
}

const START: Task[] = [
  { id: 't1', title: 'Draft the Saltmarsh welcome note', owner: 'Alice', done: false },
  { id: 't2', title: 'Check the Riverbend import', owner: 'Bob', done: true },
  { id: 't3', title: 'Answer the Harborlight review', owner: 'Alice', done: false },
];

function TaskCard({ task, onToggle }: { task: Task; onToggle: (id: string) => void }) {
  const trigger = `owner-${task.id}`;
  return (
    <wa-card id={`task-${task.id}`}>
      <div class="wa-stack wa-gap-s">
        <div class="trial-row">
          <h2>{task.title}</h2>
          <wa-tag variant={task.done ? 'success' : 'neutral'}>{task.done ? 'Done' : 'Open'}</wa-tag>
        </div>
        <div class="trial-row">
          <wa-button id={trigger} appearance="outlined">
            {task.owner}
          </wa-button>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: wa-button fires click on Enter and Space itself */}
          <wa-button id={`toggle-${task.id}`} variant="brand" onClick={() => onToggle(task.id)}>
            {task.done ? 'Reopen' : 'Mark done'}
          </wa-button>
        </div>
        <wa-popover for={trigger} placement="bottom">
          <span>{`${task.owner} owns this task.`}</span>
        </wa-popover>
      </div>
    </wa-card>
  );
}

function App() {
  const [tasks, setTasks] = useState(START);
  const open = tasks.filter((t) => !t.done).length;
  const toggle = (id: string) =>
    setTasks((all) => all.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  return (
    <main class="trial-page wa-stack">
      <div class="trial-row">
        <h1>Tasks</h1>
        <wa-badge id="open-count" variant="brand">{`${open} open`}</wa-badge>
      </div>
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} onToggle={toggle} />
      ))}
    </main>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
