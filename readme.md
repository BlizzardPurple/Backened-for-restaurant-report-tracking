# README - Store Monitoring API

## Overview

This project is part of a take-home interview assignment. It aims to build a backend system that monitors the uptime and downtime of restaurants based on their business hours and status data. The system has two main APIs:

1. **/trigger_report**: Starts generating a report for a restaurant’s uptime/downtime.
2. **/get_report**: Retrieves the report status or gets the generated CSV file.

### Features
- Reads data from CSV files and stores it in a database.
- Creates reports that show how long restaurants were up or down in the past hour, day, and week.
- Runs report generation in the background to avoid delays.
- Tries to estimate uptime/downtime even if the polling data is incomplete.

## Prerequisites

- Python 3.x
- Flask
- SQLite (just for the prototype)
- APScheduler for background tasks
- pytz for timezone handling
- Thunder client or any API testing tool (optional)

### Installation

1. Clone this repo.
2. Install all dependencies:

   ```bash
   pip install -r requirements.txt
   ```

3. Make sure the CSV files (`store_status.csv`, `business_hours.csv`, `timezones.csv`) are in the project folder.
4. Run the Flask server:

   ```bash
   python app.py
   ```

### API Usage

1. **Trigger Report Generation**  
   POST: `http://localhost:5000/trigger_report`  
   This endpoint triggers the report generation. You'll get a `report_id` back that you’ll use later to check progress.

2. **Get Report**  
   GET: `http://localhost:5000/get_report?report_id={report_id}`  
   Use this to either check the status of the report or download the report once it's done.

## JavaScript Version

Along with the Python implementation, there's also a JavaScript solution available under the `js/` directory. It shows the same logic done using a different stack.

## Known Problems and Possible Improvements

1. **Edge Cases in Business Logic**:
   - The current logic to estimate uptime/downtime might struggle with missing or irregular data points. This could be refined to produce more accurate results.
   - When some stores don’t have business hours or timezone data, they default to 24x7 open hours or the `America/Chicago` timezone. We can improve this by fetching that missing data automatically.

2. **Database Optimisation**:
   - We’re using SQLite for now, but for larger datasets, it might slow down. Switching to a better database like PostgreSQL would help.
   - Adding indexes on columns like `store_id`, `timestamp_utc`, and `report_id` will make things run faster.

3. **Efficiency in Report Generation**:
   - The current report generation can be improved by batching queries or reducing unnecessary loops. We could also use pandas to handle CSV and data processing more efficiently.

4. **Handling Live Data**:
   - This project assumes the provided CSV data is static. But in real life, we would want the system to handle live data streams, maybe using tools like RabbitMQ or Kafka for real-time updates.

5. **User Interface**:
   - Right now, there’s no frontend. A simple UI for triggering reports, viewing restaurant statuses, or setting filters would make this much more user-friendly.

6. **Error Handling**:
   - Errors are being logged, but users don’t get much feedback if something goes wrong. Adding better error messages and notifications would improve the user experience.

## Future Improvements

1. **Real-Time Monitoring**:
   - Extend the system to provide real-time updates on restaurant statuses using streaming data.
   - Maybe add WebSockets so restaurants can get notified right away if there’s downtime.

2. **Custom Reports**:
   - Let users choose custom time ranges, specific stores, or generate weekly/monthly reports instead of just hour/day/week.

3. **Scaling**:
   - As the system grows, we’ll want to scale it horizontally using Docker or Kubernetes to handle more users and more data.

4. **Frontend**:
   - Eventually, building a nice web interface using React or Angular would make this more interactive and easy to use.

### Final Thoughts

This project shows how we can build a flexible API system for monitoring restaurant uptime/downtime. There's a lot of room to improve, especially in performance and scalability, but this is a strong starting point for a system like this.

---

Let me know if you have any questions or if something isn’t clear!

Garvit Jain
BlizzardPurple
garvitrita2002@gmail.com
