import { exec } from 'child_process';
import { promisify } from 'util';

// Promisify the exec function
export const execPromise = promisify(exec); 