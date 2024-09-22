# how to run: python app.py
# go to thunder client and set request to post: http://localhost:5000/trigger_report
# save the report id
# go to thunder client and set request to get: http://localhost:5000/get_report?report_id={report_id}
# check for reports in the folder

from flask import Flask, request, send_file, jsonify
import sqlite3
import uuid
import csv
from datetime import datetime, timedelta
import pytz
import os
from apscheduler.schedulers.background import BackgroundScheduler
import traceback

app = Flask(__name__)

#setup db
def get_db():
    db = sqlite3.connect('store_monitoring.db')
    db.row_factory = sqlite3.Row
    return db

#init db
def init_db():
    db = get_db()
    cursor = db.cursor()

    #create 4 tables
    cursor.executescript('''
        CREATE TABLE IF NOT EXISTS store_status (
            store_id TEXT,
            timestamp_utc TEXT,
            status TEXT
        );

        CREATE TABLE IF NOT EXISTS business_hours (
            store_id TEXT,
            day_of_week INTEGER,
            start_time_local TEXT,
            end_time_local TEXT
        );

        CREATE TABLE IF NOT EXISTS timezones (
            store_id TEXT,
            timezone_str TEXT
        );

        CREATE TABLE IF NOT EXISTS reports (
            report_id TEXT PRIMARY KEY,
            status TEXT,
            csv_path TEXT
        );
    ''')

    db.commit()
    load_csv_data(db)

def load_csv_data(db):
    csv_files = {
        'store_status.csv': ('store_status', ['store_id', 'timestamp_utc', 'status']),
        'business_hours.csv': ('business_hours', ['store_id', 'day_of_week', 'start_time_local', 'end_time_local']),
        'timezones.csv': ('timezones', ['store_id', 'timezone_str'])
    }

    for filename, (table_name, columns) in csv_files.items():
        file_path = os.path.join(os.getcwd(), filename)
        if not os.path.exists(file_path):
            app.logger.warning(f"Warning: {filename} not found. Skipping...")
            continue

        app.logger.info(f"Loading data from {filename} into {table_name} table...")
        
        with open(file_path, 'r') as csvfile:
            csv_reader = csv.DictReader(csvfile)
            to_db = []
            for row in csv_reader:
                to_db.append(tuple(row[col] for col in columns))

        placeholders = ','.join(['?' for _ in columns])
        db.executemany(
            f"INSERT INTO {table_name} ({','.join(columns)}) VALUES ({placeholders})",
            to_db
        )
        
        db.commit()
        app.logger.info(f"Loaded {len(to_db)} rows into {table_name} table.")

    app.logger.info("CSV data loading complete.")

init_db()

#still kinda async for report generation, trigger_report route/api
scheduler = BackgroundScheduler()
scheduler.start()

@app.route('/trigger_report', methods=['POST'])
def trigger_report():
    report_id = str(uuid.uuid4())
    db = get_db()
    db.execute('INSERT INTO reports (report_id, status) VALUES (?, ?)', (report_id, 'Running'))
    db.commit()
    
    scheduler.add_job(generate_report, args=[report_id])
    
    return jsonify({"report_id": report_id})

@app.route('/get_report', methods=['GET'])
def get_report():
    report_id = request.args.get('report_id')
    if not report_id:
        return "Missing report_id parameter", 400

    db = get_db()
    row = db.execute('SELECT status, csv_path FROM reports WHERE report_id = ?', (report_id,)).fetchone()
    
    if not row:
        return "Report not found", 404

    status, csv_path = row['status'], row['csv_path']
    
    if status == 'Running':
        return "Running"
    elif status == 'Complete':
        if os.path.exists(csv_path):
            return send_file(csv_path, mimetype='text/csv', as_attachment=True, download_name=f"report_{report_id}.csv")
        else:
            return "Report file not found", 500
    else:
        return "Error generating report", 500

def generate_report(report_id):
    try:
        db = get_db()
        report_data = calculate_uptime_downtime(db)
        csv_path = os.path.join(app.root_path, f"report_{report_id}.csv")
        
        with open(csv_path, 'w', newline='') as csvfile:
            writer = csv.writer(csvfile)
            writer.writerow(['store_id', 'uptime_last_hour', 'uptime_last_day', 'uptime_last_week',
                             'downtime_last_hour', 'downtime_last_day', 'downtime_last_week'])
            writer.writerows(report_data)

        db.execute('UPDATE reports SET status = ?, csv_path = ? WHERE report_id = ?', 
                   ('Complete', csv_path, report_id))
        db.commit()
    except Exception as e:
        app.logger.error(f"Error generating report: {e}")
        app.logger.error(f"Traceback: {traceback.format_exc()}")
        db.execute('UPDATE reports SET status = ? WHERE report_id = ?', ('Failed', report_id))
        db.commit()

def calculate_uptime_downtime(db):
    current_time_row = db.execute('SELECT MAX(timestamp_utc) FROM store_status').fetchone()
    if not current_time_row or not current_time_row[0]:
        app.logger.error("No data found in store_status table")
        return []

    current_time = datetime.fromisoformat(current_time_row[0].rstrip('Z'))
    
    report_data = []
    stores = db.execute('SELECT DISTINCT store_id FROM store_status').fetchall()
    
    for store in stores:
        store_id = store['store_id']
        timezone = get_store_timezone(db, store_id)
        business_hours = get_business_hours(db, store_id)
        
        try:
            uptime_last_hour, downtime_last_hour = calculate_time_range(db, store_id, current_time, timedelta(hours=1), timezone, business_hours)
            uptime_last_day, downtime_last_day = calculate_time_range(db, store_id, current_time, timedelta(days=1), timezone, business_hours)
            uptime_last_week, downtime_last_week = calculate_time_range(db, store_id, current_time, timedelta(weeks=1), timezone, business_hours)
            
            report_data.append([
                store_id,
                uptime_last_hour, uptime_last_day, uptime_last_week,
                downtime_last_hour, downtime_last_day, downtime_last_week
            ])
        except Exception as e:
            app.logger.error(f"Error calculating uptime/downtime for store {store_id}: {e}")
    
    return report_data

def get_store_timezone(db, store_id):
    row = db.execute('SELECT timezone_str FROM timezones WHERE store_id = ?', (store_id,)).fetchone()
    return row['timezone_str'] if row else 'America/Chicago'

def get_business_hours(db, store_id):
    rows = db.execute('SELECT * FROM business_hours WHERE store_id = ?', (store_id,)).fetchall()
    if not rows:
        return [(i, '00:00:00', '23:59:59') for i in range(7)]
    
    business_hours = [(row['day_of_week'], row['start_time_local'], row['end_time_local']) for row in rows]
    #logic for keeping 7 days
    for i in range(7):
        if not any(day[0] == i for day in business_hours):
            business_hours.append((i, '00:00:00', '23:59:59'))
    
    return sorted(business_hours)

def calculate_time_range(db, store_id, end_time, duration, timezone, business_hours):
    start_time = end_time - duration
    local_tz = pytz.timezone(timezone)
    
    uptime = timedelta()
    downtime = timedelta()
    current_time = start_time
    
    while current_time < end_time:
        local_time = current_time.astimezone(local_tz)
        day_of_week = local_time.weekday()
        
        if day_of_week < len(business_hours):
            if is_business_hours(local_time, business_hours[day_of_week]):
                status = get_store_status(db, store_id, current_time)
                if status == 'active':
                    uptime += timedelta(hours=1)
                else:
                    downtime += timedelta(hours=1)
        else:
            app.logger.warning(f"Missing business hours for day {day_of_week} for store {store_id}")
        
        current_time += timedelta(hours=1)
    
    return uptime.total_seconds() / 60, downtime.total_seconds() / 60

def is_business_hours(local_time, business_hours):
    day_of_week, start_time, end_time = business_hours
    start_time = datetime.strptime(start_time, '%H:%M:%S').time()
    end_time = datetime.strptime(end_time, '%H:%M:%S').time()
    return start_time <= local_time.time() <= end_time

def get_store_status(db, store_id, timestamp):
    row = db.execute('SELECT status FROM store_status WHERE store_id = ? AND timestamp_utc <= ? ORDER BY timestamp_utc DESC LIMIT 1',
                     (store_id, timestamp.isoformat() + 'Z')).fetchone()
    return row['status'] if row else 'inactive'

if __name__ == '__main__':
    app.run(debug=True)