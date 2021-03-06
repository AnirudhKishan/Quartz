const scheduleCsv =`"activity","start","category"
"Wake up, Brush, Coffee",05:30:00,"routine"
"Daily start-up reflection (Work)",06:15:00,"work-lite"
"Morning routine",06:45:00,"health"
"Yoga / Exercise",07:00:00,"health"
"Breakfast",08:30:00,"meal"
"Shower et al.",09:00:00,"health"
"Meditation",09:45:00,"health"
"Work",10:00:00,"work"
"Lunch",12:45:00,"meal"
"Relax (after lunch)",13:15:00,"relax"
"Work",13:45:00,"work"
"Daily start-up reflection (Personal)",18:00:00,"personal-lite"
"Personal",18:30:00,"personal"
"Dinner",20:00:00,"meal"
"Relax (after dinner)",20:30:00,"relax"
"Daily wind-down reflection (Work & Personal)",21:00:00,"work-lite"
"Night Routine",21:30:00,"routine"
"Relax (at night)",22:00:00,"relax"
"Sleep",22:30:00,"sleep"
`;

const categoryColour = {
	"work": "skyblue",
	"work-lite": "lightblue",
	"personal": "mediumspringgreen",
	"personal-lite": "palegreen",
	"routine": "antiquewhite",
	"meal": "tan",
	"health": "moccasin",
	"relax": "aquamarine",
	"sleep": "lightgray",
};

let scheduleRaw = $.csv.toObjects(scheduleCsv);

let schedule = [];

for (i in scheduleRaw) {
	let	startHour = parseInt(scheduleRaw[i].start.split(":")[0]);
	let	startMinute = parseInt(scheduleRaw[i].start.split(":")[1]);

	schedule.push({
		activity: scheduleRaw[i].activity,
		startHour: startHour,
		startMinute: startMinute,
		category: scheduleRaw[i].category,
	});
	
	if (i > 0) {
		schedule[i-1].endHour = startHour;
		schedule[i-1].endMinute = startMinute;
	}
	
	if (parseInt(i) === (scheduleRaw.length - 1)) {
		schedule[i].endHour = 25;
		schedule[i].endMinute = 0;
	}
};

render(schedule);
setInterval(() => {render(schedule);}, 10000);

function render(data) {
	$("#schedule").empty();
	
	let html = "<table border=1>";
	
	html += "<thead><th>Activity</th><th>Start</th><th>End</th></thead>";
	
	html +=  "<tbody>";
	
	for (item of data) {
		html += "<tr style=\"background-color: " + categoryColour[item.category] + ";\">";
		
		html +=  "<td>" + item.activity + "</td>";
		html +=  "<td>" + item.startHour.toString().padStart(2,'0') + ":" + item.startMinute.toString().padStart(2,'0') + "</td>";
		html +=  "<td>" + (item.endHour===25 ? 0 : item.endHour).toString().padStart(2,'0') + ":" + item.endMinute.toString().padStart(2,'0') + "</td>";
		
		if (isActive(item)) {
			html += "<td> <-- </td>"
		}
		
		html += "</tr>";
	}
	
	html +=  "</tbody>";
	
	html +=  "</table>";
	
	$("#schedule").append(html);
}

function isActive(item) {
	let nowDate = new Date();
	
	var startDate = new Date();
	startDate.setHours(item.startHour);
	startDate.setMinutes(item.startMinute);
	
	var endDate = new Date();
	endDate.setHours(item.endHour);
	endDate.setMinutes(item.endMinute);
	
	return nowDate >= startDate && nowDate < endDate;
}

if ("serviceWorker" in navigator) {
  // register service worker
  navigator.serviceWorker.register("./sw.js");
}

