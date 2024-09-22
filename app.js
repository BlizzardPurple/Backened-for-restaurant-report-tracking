// app.js

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const csvParser = require('csv-parser');
const fs = require('fs');
const moment = require('moment-timezone');
const axios = require('axios');
const path = require('path');

const app = express();
const port = 3000;

// Initialize in-memory SQLite database
const db = new sqlite3.Database(':memory:');

// Create necessary tables
db.serialize(() => {
    // Table for store status
    db.run(`
    CREATE TABLE store_status (
      store_id TEXT,
      timestamp_utc TEXT,
      status TEXT
    )
  `);

    // Table for business hours
    db.run(`
    CREATE TABLE business_hours (
      store_id TEXT,
      day_of_week INTEGER,
      start_time_local TEXT,
      end_time_local TEXT
    )
  `);

    // Table for store timezones
    db.run(`
    CREATE TABLE timezones (
      store_id TEXT,
      timezone_str TEXT
    )
  `);

    // Table for reports
    db.run(`
    CREATE TABLE reports (
      report_id TEXT,
      status TEXT,
      csv_path TEXT
    )
  `);
});

// Function to load CSV data into the database
async function loadCsvData() {
    // Local file paths of the CSV files
    const storeStatusFile = path.join(__dirname, 'store_status.csv');
    const businessHoursFile = path.join(__dirname, 'business_hours.csv');
    const timezonesFile = path.join(__dirname, 'timezones.csv');
  
    // Helper function to parse CSV and insert into database
    const parseCsvAndInsert = async (filePath, tableName, columns) => {
      return new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(filePath)
          .pipe(csvParser())
          .on('data', (data) => {
            const row = {};
            columns.forEach((col) => {
              row[col] = data[col];
            });
            rows.push(row);
          })
          .on('end', () => {
            // Insert data into the database
            const placeholders = columns.map(() => '?').join(',');
            const query = `INSERT INTO ${tableName} (${columns.join(',')}) VALUES (${placeholders})`;
            const stmt = db.prepare(query);
            rows.forEach((row) => {
              const values = columns.map((col) => row[col]);
              stmt.run(values);
            });
            stmt.finalize();
            resolve();
          })
          .on('error', reject);
      });
    };
  
    // Load store status data
    await parseCsvAndInsert(storeStatusFile, 'store_status', ['store_id', 'timestamp_utc', 'status']);
  
    // Load business hours data
    await parseCsvAndInsert(businessHoursFile, 'business_hours', ['store_id', 'day_of_week', 'start_time_local', 'end_time_local']);
  
    // Load timezones data
    await parseCsvAndInsert(timezonesFile, 'timezones', ['store_id', 'timezone_str']);
  }
  



// Call the function to load CSV data into the database
loadCsvData().then(() => {
    console.log('CSV data loaded into the database.');
});

// API to trigger report generation
app.post('/trigger_report', (req, res) => {
    const reportId = uuidv4();
    db.run(`INSERT INTO reports (report_id, status) VALUES (?, 'Running')`, [reportId], (err) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to create report' });
        }

        // Generate the report asynchronously
        generateReport(reportId);
        res.json({ report_id: reportId });
    });
});

// API to get the report status or download the CSV
app.get('/get_report', (req, res) => {
    const reportId = req.query.report_id;
    if (!reportId) {
        return res.status(400).send('Missing report_id parameter');
    }

    db.get(`SELECT status, csv_path FROM reports WHERE report_id = ?`, [reportId], (err, row) => {
        if (err || !row) {
            return res.status(404).send('Report not found');
        }

        if (row.status === 'Running') {
            res.send('Running');
        } else {
            res.download(row.csv_path, `report_${reportId}.csv`);
        }
    });
});

// Function to generate the report
function generateReport(reportId) {
    // Simulate asynchronous operation
    setTimeout(async () => {
        try {
            const reportData = await calculateUptimeDowntime();
            const csvPath = path.join(__dirname, `report_${reportId}.csv`);
            const csvContent = reportData.map((row) => row.join(',')).join('\n');
            fs.writeFileSync(csvPath, csvContent);

            // Update the report status in the database
            db.run(`UPDATE reports SET status = 'Complete', csv_path = ? WHERE report_id = ?`, [csvPath, reportId]);
            console.log(`Report ${reportId} generated.`);
        } catch (error) {
            console.error('Error generating report:', error);
            db.run(`UPDATE reports SET status = 'Failed' WHERE report_id = ?`, [reportId]);
        }
    }, 0);
}

// Function to calculate uptime and downtime
async function calculateUptimeDowntime() {
    return new Promise((resolve, reject) => {
        // Get the current timestamp (max timestamp in store_status)
        db.get(`SELECT MAX(timestamp_utc) as max_timestamp FROM store_status`, [], (err, row) => {
            if (err) {
                return reject(err);
            }

            const currentTimestampUtc = row.max_timestamp;
            const currentMomentUtc = moment.utc(currentTimestampUtc);

            // Get all store IDs
            db.all(`SELECT DISTINCT store_id FROM store_status`, [], (err, stores) => {
                if (err) {
                    return reject(err);
                }

                const reportData = [];
                // Header row for the CSV
                reportData.push(['store_id', 'uptime_last_hour(minutes)', 'uptime_last_day(hours)', 'uptime_last_week(hours)', 'downtime_last_hour(minutes)', 'downtime_last_day(hours)', 'downtime_last_week(hours)']);

                let processedStores = 0;

                stores.forEach((store) => {
                    const storeId = store.store_id;

                    // Get the timezone for the store
                    db.get(`SELECT timezone_str FROM timezones WHERE store_id = ?`, [storeId], (err, tzRow) => {
                        let timezone = 'America/Chicago'; // Default timezone
                        if (tzRow && tzRow.timezone_str) {
                            timezone = tzRow.timezone_str;
                        }

                        // Get business hours for the store
                        db.all(`SELECT * FROM business_hours WHERE store_id = ?`, [storeId], (err, bhRows) => {
                            let businessHours = bhRows;
                            if (!bhRows || bhRows.length === 0) {
                                // If missing, assume open 24/7
                                businessHours = [];
                                for (let i = 0; i < 7; i++) {
                                    businessHours.push({
                                        store_id: storeId,
                                        dayOfWeek: i,
                                        start_time_local: '00:00:00',
                                        end_time_local: '23:59:59',
                                    });
                                }
                            }

                            // Calculate uptime and downtime for last hour, day, week
                            calculateStoreUptimeDowntime(storeId, timezone, businessHours, currentMomentUtc, (err, result) => {
                                if (err) {
                                    console.error('Error calculating uptime/downtime for store:', storeId, err);
                                } else {
                                    reportData.push([
                                        storeId,
                                        result.uptime_last_hour,
                                        result.uptime_last_day,
                                        result.uptime_last_week,
                                        result.downtime_last_hour,
                                        result.downtime_last_day,
                                        result.downtime_last_week,
                                    ]);
                                }

                                processedStores++;
                                if (processedStores === stores.length) {
                                    resolve(reportData);
                                }
                            });
                        });
                    });
                });
            });
        });
    });
}

// Function to calculate uptime/downtime for a single store
function calculateStoreUptimeDowntime(storeId, timezone, businessHours, currentMomentUtc, callback) {
    // Time intervals
    const intervals = [
        { label: 'last_hour', duration: moment.duration(1, 'hour') },
        { label: 'last_day', duration: moment.duration(1, 'day') },
        { label: 'last_week', duration: moment.duration(7, 'days') },
    ];

    const results = {};

    let processedIntervals = 0;

    intervals.forEach((interval) => {
        const startTimeUtc = moment.utc(currentMomentUtc).subtract(interval.duration);

        // Get relevant status logs for the store within the interval
        db.all(
            `SELECT * FROM store_status WHERE store_id = ? AND timestamp_utc >= ? AND timestamp_utc <= ? ORDER BY timestamp_utc`,
            [storeId, startTimeUtc.format(), currentMomentUtc.format()],
            (err, statusRows) => {
                if (err) {
                    return callback(err);
                }

                // If no status rows, assume store was inactive
                if (!statusRows || statusRows.length === 0) {
                    results[`uptime_${interval.label}`] = 0;
                    results[`downtime_${interval.label}`] = interval.duration.asHours();
                    processedIntervals++;
                    if (processedIntervals === intervals.length) {
                        callback(null, results);
                    }
                    return;
                }

                // Build a timeline of statuses
                const timeline = [];

                // Add start and end markers
                timeline.push({
                    timestamp_utc: startTimeUtc.format(),
                    status: statusRows[0].status,
                });

                timeline.push(...statusRows);

                timeline.push({
                    timestamp_utc: currentMomentUtc.format(),
                    status: statusRows[statusRows.length - 1].status,
                });

                // Calculate uptime and downtime within business hours
                let uptime = 0;
                let downtime = 0;

                for (let i = 0; i < timeline.length - 1; i++) {
                    const start = moment.utc(timeline[i].timestamp_utc);
                    const end = moment.utc(timeline[i + 1].timestamp_utc);
                    let status = timeline[i].status; // 'active' or 'inactive'

                    // Convert to local time
                    const startLocal = start.clone().tz(timezone);
                    const endLocal = end.clone().tz(timezone);

                    // Check if the time period overlaps with business hours
                    const businessTime = getBusinessTimeOverlap(startLocal, endLocal, businessHours);

                    const duration = businessTime.asMinutes();

                    if (duration > 0) {
                        if (status === 'active') {
                            uptime += duration;
                        } else {
                            downtime += duration;
                        }
                    }
                }

                // Assign results
                results[`uptime_${interval.label}`] = parseFloat((uptime / 60).toFixed(2)); // Convert minutes to hours
                results[`downtime_${interval.label}`] = parseFloat((downtime / 60).toFixed(2));

                processedIntervals++;
                if (processedIntervals === intervals.length) {
                    callback(null, results);
                }
            }
        );
    });
}

// Function to calculate overlap between a time interval and business hours
function getBusinessTimeOverlap(startLocal, endLocal, businessHours) {
    let totalBusinessMinutes = moment.duration(0);

    // Iterate over each day in the interval
    let current = startLocal.clone();
    while (current.isBefore(endLocal)) {
        const dayOfWeek = current.day(); // 0 = Sunday, 6 = Saturday

        const bhForDay = businessHours.filter((bh) => parseInt(bh.dayOfWeek) === dayOfWeek);

        bhForDay.forEach((bh) => {
            const bhStart = moment.tz(current.format('YYYY-MM-DD') + ' ' + bh.start_time_local, bh.start_time_local.length > 8 ? 'YYYY-MM-DD HH:mm:ss.SSS' : 'YYYY-MM-DD HH:mm:ss', current.zoneName());
            const bhEnd = moment.tz(current.format('YYYY-MM-DD') + ' ' + bh.end_time_local, bh.end_time_local.length > 8 ? 'YYYY-MM-DD HH:mm:ss.SSS' : 'YYYY-MM-DD HH:mm:ss', current.zoneName());

            // Handle overnight shifts
            if (bhEnd.isBefore(bhStart)) {
                bhEnd.add(1, 'day');
            }

            const overlapStart = moment.max(current, bhStart);
            const overlapEnd = moment.min(endLocal, bhEnd);

            if (overlapEnd.isAfter(overlapStart)) {
                totalBusinessMinutes.add(moment.duration(overlapEnd.diff(overlapStart)));
            }
        });

        current.add(1, 'day').startOf('day');
    }

    return totalBusinessMinutes;
}

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
