import { createLogger, format, transports } from 'winston';
const { combine, timestamp, printf, colorize } = format;

// Define custom colors for each log level
const customColors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'blue',
  verbose: 'cyan'
};

// Custom format for log messages with colors
const myFormat = printf(({ level, message, timestamp }) => {
  return `${timestamp} [${level}]: ${message}`;
});

// Create the logger instance
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    myFormat
  ),
  transports: [
    new transports.Console({
      format: combine(
        colorize({ all: true, colors: customColors }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        myFormat
      )
    }),
    // Add file transport for production (without colors)
    ...(process.env.NODE_ENV === 'production' 
      ? [
          new transports.File({ 
            filename: 'logs/error.log', 
            level: 'error',
            format: combine(
              timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
              myFormat
            )
          }),
          new transports.File({ 
            filename: 'logs/combined.log',
            format: combine(
              timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
              myFormat
            )
          })
        ]
      : [])
  ],
});

// Add custom colors to Winston
format.colorize().addColors(customColors);

// Ensure log directory exists in production
if (process.env.NODE_ENV === 'production') {
  const fs = require('fs');
  const path = require('path');
  const logDir = 'logs';
  
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }
}

export default logger; 